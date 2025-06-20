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

// Middleware dengan konfigurasi yang diperbesar untuk file besar
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range']
}));

// Perbesar limit untuk JSON dan URL encoded data
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
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

// Multer configuration dengan konfigurasi yang lebih optimal untuk file besar
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 200 * 1024 * 1024, // Naikkan ke 200MB
    files: 1,
    fields: 1,
    fieldSize: 200 * 1024 * 1024, // Tambahkan field size limit
    headerPairs: 2000 // Tambahkan header pairs limit
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

// API endpoint for file upload dengan timeout yang lebih panjang
app.post('/api/upload', (req, res, next) => {
  // Set timeout untuk file besar (10 menit)
  req.setTimeout(600000);
  res.setTimeout(600000);
  next();
}, upload.single('file'), async (req, res) => {
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

// Serve files from GitHub dengan optimasi untuk file besar
app.get('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Validate filename format
    if (!isValidFilename(filename)) {
      return res.status(404).json({ error: 'File not found' });
    }

    console.log(`Serving file: ${filename}`);

    // Set timeout untuk file besar
    req.setTimeout(600000);
    res.setTimeout(600000);

    const result = await getFileFromGitHub(filename);
    
    if (result.success) {
      const extension = path.extname(filename).slice(1).toLowerCase();
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      // Set appropriate headers untuk file besar
      const headers = {
        'Content-Type': mimeType,
        'Content-Length': result.data.length,
        'Cache-Control': 'public, max-age=31536000', // 1 year cache
        'Access-Control-Allow-Origin': '*',
        'X-File-Name': filename,
        'Accept-Ranges': 'bytes' // Selalu aktifkan range requests
      };

      // Handle range requests untuk streaming file besar
      const range = req.headers.range;
      if (range) {
        const parts = range.replace(/bytes=/, "").split("-");
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : result.data.length - 1;
        const chunksize = (end - start) + 1;
        
        // Validasi range
        if (start >= result.data.length || end >= result.data.length) {
          res.status(416).set({
            'Content-Range': `bytes */${result.data.length}`
          });
          return res.end();
        }
        
        headers['Content-Range'] = `bytes ${start}-${end}/${result.data.length}`;
        headers['Content-Length'] = chunksize;
        
        console.log(`Serving range: ${start}-${end}/${result.data.length} for ${filename}`);
        
        res.writeHead(206, headers);
        res.end(result.data.slice(start, end + 1));
        return;
      }

      // Untuk file besar (>10MB), gunakan streaming
      if (result.data.length > 10 * 1024 * 1024) {
        console.log(`Streaming large file: ${filename} (${result.data.length} bytes)`);
        
        headers['Content-Disposition'] = `inline; filename="${filename}"`;
        res.set(headers);
        
        // Stream file dalam chunks untuk menghindari memory issues
        const chunkSize = 1024 * 1024; // 1MB chunks
        let offset = 0;
        
        const sendChunk = () => {
          if (offset >= result.data.length) {
            res.end();
            return;
          }
          
          const chunk = result.data.slice(offset, Math.min(offset + chunkSize, result.data.length));
          res.write(chunk);
          offset += chunkSize;
          
          // Non-blocking next chunk
          setImmediate(sendChunk);
        };
        
        sendChunk();
      } else {
        // File kecil, kirim langsung
        headers['Content-Disposition'] = `inline; filename="${filename}"`;
        res.set(headers);
        res.send(result.data);
      }
    } else {
      console.log(`File not found: ${filename}`);
      res.status(404).json({ error: 'File not found' });
    }

  } catch (error) {
    console.error('File serve error:', error);
    
    // Handle timeout errors
    if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
      res.status(408).json({ 
        error: 'Request timeout',
        details: 'File is too large or connection is slow. Please try again.'
      });
    } else {
      res.status(500).json({ 
        error: 'Internal server error',
        details: error.message
      });
    }
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
        sha: result.sha,
        supportsRangeRequests: true
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
        'Accept-Ranges': 'bytes' // Selalu aktifkan untuk semua file
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
    memory: process.memoryUsage(),
    maxFileSize: '200MB'
  });
});

// Enhanced error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    console.error('Multer error:', error);
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ 
        error: 'File too large', 
        details: 'Maximum file size is 200MB',
        maxSize: '200MB'
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
  
  // Handle PayloadTooLarge error
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload too large',
      details: 'Request entity is too large',
      maxSize: '200MB'
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

// Server configuration dengan optimasi untuk file besar
const server = app.listen(PORT, () => {
  console.log(`CDN Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Max file size: 200MB`);
  console.log(`Supported file types: All types supported`);
  console.log(`Streaming enabled for files > 10MB`);
});

// Konfigurasi server timeout untuk file besar
server.timeout = 600000; // 10 menit
server.keepAliveTimeout = 65000; // 65 detik
server.headersTimeout = 66000; // 66 detik

// Tingkatkan max listeners untuk menghindari memory leak warnings
server.setMaxListeners(0);
