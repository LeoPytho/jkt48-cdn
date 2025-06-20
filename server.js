import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileTypeFromBuffer } from 'file-type';
import { uploadToGitHub, getFileFromGitHub, isValidFilename, getFileInfo, getSupportedFileTypes } from './utils/github.js';
import mime from 'mime-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// Enhanced file type detection
async function detectFileType(buffer, originalFilename) {
  let detectedType = null;
  let extension = 'bin';
  let mimeType = 'application/octet-stream';

  try {
    // Try to detect file type from buffer
    detectedType = await fileTypeFromBuffer(buffer);
    
    if (detectedType) {
      extension = detectedType.ext;
      mimeType = detectedType.mime;
    } else if (originalFilename) {
      // Fallback to filename extension
      const fileExt = path.extname(originalFilename).slice(1).toLowerCase();
      if (fileExt) {
        extension = fileExt;
        mimeType = mime.lookup(extension) || 'application/octet-stream';
      }
    }

    // Special handling for common file types that might not be detected
    const firstBytes = buffer.slice(0, 20);
    
    // Check for additional video formats
    if (extension === 'bin' || !detectedType) {
      const filename = originalFilename?.toLowerCase() || '';
      
      if (filename.endsWith('.mp4') || filename.endsWith('.m4v')) {
        extension = 'mp4';
        mimeType = 'video/mp4';
      } else if (filename.endsWith('.avi')) {
        extension = 'avi';
        mimeType = 'video/x-msvideo';
      } else if (filename.endsWith('.mov')) {
        extension = 'mov';
        mimeType = 'video/quicktime';
      } else if (filename.endsWith('.wmv')) {
        extension = 'wmv';
        mimeType = 'video/x-ms-wmv';
      } else if (filename.endsWith('.flv')) {
        extension = 'flv';
        mimeType = 'video/x-flv';
      } else if (filename.endsWith('.webm')) {
        extension = 'webm';
        mimeType = 'video/webm';
      } else if (filename.endsWith('.mkv')) {
        extension = 'mkv';
        mimeType = 'video/x-matroska';
      } else if (filename.endsWith('.3gp')) {
        extension = '3gp';
        mimeType = 'video/3gpp';
      }
    }

  } catch (error) {
    console.warn('File type detection failed:', error.message);
    // Keep defaults
  }

  return { extension, mimeType, detectedType };
}

// Multer configuration for file upload with better error handling
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 1,
    fields: 1
  },
  fileFilter: (req, file, cb) => {
    // Allow all file types but log what we're receiving
    console.log(`Receiving file: ${file.originalname}, mimetype: ${file.mimetype}, size: ${file.size || 'unknown'}`);
    cb(null, true);
  }
});

// Serve homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Get supported file types
app.get('/api/supported-types', (req, res) => {
  res.json(getSupportedFileTypes());
});

// API endpoint for file upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded',
        details: 'Please select a file to upload'
      });
    }

    const buffer = req.file.buffer;
    const originalFilename = req.file.originalname;
    
    console.log(`Processing upload: ${originalFilename}, size: ${buffer.length} bytes`);

    // Validate buffer
    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ 
        error: 'Empty file',
        details: 'The uploaded file appears to be empty'
      });
    }

    // Enhanced file type detection
    const { extension, mimeType, detectedType } = await detectFileType(buffer, originalFilename);
    
    console.log(`Detected: extension=${extension}, mimeType=${mimeType}`);

    // Upload to GitHub
    const result = await uploadToGitHub(originalFilename, buffer, extension);
    
    if (result.success) {
      const fileUrl = `${req.protocol}://${req.get('host')}/${result.filename}`;
      
      const response = {
        success: true,
        filename: result.filename,
        originalFilename: originalFilename,
        url: fileUrl,
        size: buffer.length,
        type: mimeType,
        extension: extension,
        detected: !!detectedType
      };

      console.log(`Upload successful: ${result.filename}`);
      res.json(response);
    } else {
      console.error(`Upload failed: ${result.error}`);
      res.status(500).json({ 
        error: 'Upload failed',
        details: result.error
      });
    }

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Serve files from GitHub with better content handling
app.get('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Validate filename format
    if (!isValidFilename(filename)) {
      return res.status(404).json({ error: 'File not found' });
    }

    console.log(`Serving file: ${filename}`);

    const result = await getFileFromGitHub(filename);
    
    if (result.success) {
      const extension = path.extname(filename).slice(1).toLowerCase();
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      // Set appropriate headers for different file types
      const headers = {
        'Content-Type': mimeType,
        'Content-Length': result.data.length,
        'Cache-Control': 'public, max-age=31536000', // 1 year cache
        'Access-Control-Allow-Origin': '*',
        'X-File-Name': filename
      };

      // For video files, add streaming support
      if (mimeType.startsWith('video/')) {
        headers['Accept-Ranges'] = 'bytes';
        headers['Content-Disposition'] = `inline; filename="${filename}"`;
        
        // Handle range requests for video streaming
        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : result.data.length - 1;
          const chunksize = (end - start) + 1;
          
          headers['Content-Range'] = `bytes ${start}-${end}/${result.data.length}`;
          headers['Content-Length'] = chunksize;
          
          res.writeHead(206, headers);
          res.end(result.data.slice(start, end + 1));
          return;
        }
      } else {
        headers['Content-Disposition'] = `inline; filename="${filename}"`;
      }
      
      res.set(headers);
      res.send(result.data);
    } else {
      console.log(`File not found: ${filename}`);
      res.status(404).json({ error: 'File not found' });
    }

  } catch (error) {
    console.error('File serve error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
});

// API endpoint to get file info
app.get('/api/info/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Validate filename format
    if (!isValidFilename(filename)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const result = await getFileInfo(filename);
    
    if (result.success) {
      const extension = path.extname(filename).slice(1).toLowerCase();
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      res.json({
        filename: filename,
        size: result.size,
        type: mimeType,
        extension: extension,
        url: `${req.protocol}://${req.get('host')}/${filename}`,
        github_url: result.url,
        sha: result.sha
      });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    console.error('File info error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
});

// API endpoint to check if file exists (HEAD request)
app.head('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    if (!isValidFilename(filename)) {
      return res.status(404).end();
    }

    const result = await getFileInfo(filename);
    
    if (result.success) {
      const extension = path.extname(filename).slice(1);
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      res.set({
        'Content-Type': mimeType,
        'Content-Length': result.size,
        'Cache-Control': 'public, max-age=31536000',
        'X-File-Name': filename,
        'Accept-Ranges': mimeType.startsWith('video/') ? 'bytes' : 'none'
      });
      
      res.status(200).end();
    } else {
      res.status(404).end();
    }
  } catch (error) {
    console.error('HEAD request error:', error);
    res.status(500).end();
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage()
  });
});

// Enhanced error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error('Multer error:', error);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: 'File too large', 
        details: 'Maximum file size is 100MB',
        maxSize: '100MB'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ 
        error: 'Unexpected file field',
        details: 'Please use the "file" field name for uploads'
      });
    }
    return res.status(400).json({ 
      error: 'File upload error',
      details: error.message
    });
  }
  
  console.error('Unhandled error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

app.listen(PORT, () => {
  console.log(`CDN Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Max file size: 100MB`);
  console.log(`Supported file types: All types supported`);
});
