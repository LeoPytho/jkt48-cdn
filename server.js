import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileTypeFromBuffer } from 'file-type';
import { uploadToGitHub, getFileFromGitHub, isValidFilename, getFileInfo, getSupportedFileTypes } from './utils/github.js';
import mime from 'mime-types';
import fetch from 'node-fetch'; // Add this import

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range']
}));

app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static('public'));

async function detectFileType(buffer, originalFilename) {
  let detectedType = null;
  let extension = 'bin';
  let mimeType = 'application/octet-stream';

  try {
    detectedType = await fileTypeFromBuffer(buffer);
    
    if (detectedType) {
      extension = detectedType.ext;
      mimeType = detectedType.mime;
    } else if (originalFilename) {
      const fileExt = path.extname(originalFilename).slice(1).toLowerCase();
      if (fileExt) {
        extension = fileExt;
        mimeType = mime.lookup(extension) || 'application/octet-stream';
      }
    }

    if (extension === 'bin' || !detectedType) {
      const filename = originalFilename?.toLowerCase() || '';
      
      const videoTypes = {
        'mp4': 'video/mp4', 'avi': 'video/x-msvideo', 'mov': 'video/quicktime',
        'wmv': 'video/x-ms-wmv', 'flv': 'video/x-flv', 'webm': 'video/webm',
        'mkv': 'video/x-matroska', '3gp': 'video/3gpp', 'html': 'text/html',
        'htm': 'text/html'
      };
      
      for (const [ext, mime] of Object.entries(videoTypes)) {
        if (filename.endsWith(`.${ext}`)) {
          extension = ext;
          mimeType = mime;
          break;
        }
      }
    }

  } catch (error) {
    console.warn('File type detection failed:', error.message);
  }

  return { extension, mimeType, detectedType };
}

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // Reduced to 100MB for GitHub API
    files: 1,
    fields: 1,
    fieldSize: 100 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    console.log(`Receiving file: ${file.originalname}, mimetype: ${file.mimetype}`);
    cb(null, true);
  }
});

// Optimized file existence check
async function checkFileExists(filename, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await getFileInfo(filename);
      if (result && result.success) {
        return result;
      }
    } catch (error) {
      console.warn(`File check attempt ${i + 1} failed:`, error.message);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  return null;
}

// Optimized file retrieval with direct download for large files
async function getFileWithRetry(filename, maxRetries = 2) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await getFileFromGitHub(filename);
      if (result && result.success && result.data) {
        return result;
      }
    } catch (error) {
      console.warn(`File retrieval attempt ${i + 1} failed:`, error.message);
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }
  return null;
}

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/supported-types', (req, res) => {
  res.json(getSupportedFileTypes());
});

app.post('/api/upload', (req, res, next) => {
  req.setTimeout(300000); // 5 minutes
  res.setTimeout(300000);
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

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ 
        error: 'Empty file',
        details: 'The uploaded file appears to be empty'
      });
    }

    // Check GitHub API limit
    if (buffer.length > 100 * 1024 * 1024) {
      return res.status(400).json({ 
        error: 'File too large',
        details: 'Maximum file size is 100MB'
      });
    }

    const { extension, mimeType, detectedType } = await detectFileType(buffer, originalFilename);
    
    console.log(`Detected: extension=${extension}, mimeType=${mimeType}`);

    const uploadResult = await uploadToGitHub(originalFilename, buffer, extension);
    
    if (uploadResult && uploadResult.success) {
      const fileUrl = `${req.protocol}://${req.get('host')}/${uploadResult.filename}`;
      
      const response = {
        success: true,
        filename: uploadResult.filename,
        originalFilename: originalFilename,
        url: fileUrl,
        size: buffer.length,
        type: mimeType,
        extension: extension,
        detected: !!detectedType
      };

      console.log(`Upload successful: ${uploadResult.filename}`);
      res.json(response);
    } else {
      console.error(`Upload failed: ${uploadResult?.error}`);
      res.status(500).json({ 
        error: 'Upload failed',
        details: uploadResult?.error || 'Unknown error'
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

app.get('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    console.log(`Request for file: ${filename}`);
    
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      console.log(`Invalid filename format: ${filename}`);
      return res.status(404).json({ error: 'Invalid filename' });
    }

    req.setTimeout(300000); // 5 minutes
    res.setTimeout(300000);

    const fileInfo = await checkFileExists(filename);
    if (!fileInfo) {
      console.log(`File not found in info check: ${filename}`);
      return res.status(404).json({ error: 'File not found' });
    }

    const result = await getFileWithRetry(filename);
    
    if (!result || !result.success || !result.data) {
      console.log(`Failed to retrieve file: ${filename}`);
      return res.status(404).json({ error: 'File not found or corrupted' });
    }

    const extension = path.extname(filename).slice(1).toLowerCase();
    let mimeType = mime.lookup(extension) || 'application/octet-stream';
    
    const isHtmlFile = extension === 'html' || extension === 'htm';
    const forceText = req.query.text === 'true' || req.query.plain === 'true';
    
    if (isHtmlFile || forceText) {
      mimeType = 'text/plain';
      console.log(`Serving HTML file as plain text: ${filename}`);
    }
    
    const headers = {
      'Content-Type': mimeType,
      'Content-Length': result.data.length,
      'Cache-Control': 'public, max-age=31536000',
      'Access-Control-Allow-Origin': '*',
      'X-File-Name': filename,
      'Accept-Ranges': 'bytes'
    };

    // Handle range requests
    const range = req.headers.range;
    if (range && !isHtmlFile && !forceText) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : result.data.length - 1;
      const chunksize = (end - start) + 1;
      
      if (start >= result.data.length || end >= result.data.length || start > end) {
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

    headers['Content-Disposition'] = `inline; filename="${filename}"`;
    res.set(headers);
    res.send(result.data);

  } catch (error) {
    console.error('File serve error:', error);
    
    if (!res.headersSent) {
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
  }
});

app.get('/api/info/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(404).json({ error: 'Invalid filename' });
    }

    const result = await checkFileExists(filename);
    
    if (result) {
      const extension = path.extname(filename).slice(1).toLowerCase();
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      res.json({
        filename: filename,
        size: result.size,
        type: mimeType,
        extension: extension,
        url: `${req.protocol}://${req.get('host')}/${filename}`,
        textUrl: `${req.protocol}://${req.get('host')}/${filename}?text=true`,
        github_url: result.url,
        sha: result.sha,
        supportsRangeRequests: true,
        isHtml: extension === 'html' || extension === 'htm'
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

app.head('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      return res.status(404).end();
    }

    const result = await checkFileExists(filename);
    
    if (result) {
      const extension = path.extname(filename).slice(1);
      let mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      const isHtmlFile = extension === 'html' || extension === 'htm';
      const forceText = req.query.text === 'true' || req.query.plain === 'true';
      
      if (isHtmlFile || forceText) {
        mimeType = 'text/plain';
      }
      
      res.set({
        'Content-Type': mimeType,
        'Content-Length': result.size,
        'Cache-Control': 'public, max-age=31536000',
        'X-File-Name': filename,
        'Accept-Ranges': 'bytes'
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

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    maxFileSize: '100MB'
  });
});

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
    return res.status(400).json({ 
      error: 'File upload error',
      details: error.message
    });
  }
  
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload too large',
      details: 'Request entity is too large',
      maxSize: '100MB'
    });
  }
  
  console.error('Unhandled error:', error);
  
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
    });
  }
});

app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method
  });
});

const server = app.listen(PORT, () => {
  console.log(`CDN Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Max file size: 100MB`);
  console.log(`HTML files served as plain text by default`);
});

server.timeout = 300000; // 5 minutes
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.setMaxListeners(0);
