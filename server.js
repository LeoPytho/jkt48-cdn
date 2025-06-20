import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileTypeFromBuffer } from 'file-type';
import { 
  uploadToGitHub, 
  getFileFromGitHubRobust, 
  isValidFilename, 
  getFileInfo, 
  getSupportedFileTypes,
  checkFileExists
} from './utils/github.js';
import mime from 'mime-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Enhanced CORS configuration
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'HEAD', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Range'],
  exposedHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length', 'X-File-Name']
}));

// Increased limits for large files
app.use(express.json({ limit: '200mb' }));
app.use(express.urlencoded({ extended: true, limit: '200mb' }));
app.use(express.static('public'));

// Enhanced file type detection with better fallbacks
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
    if (extension === 'bin' || !detectedType) {
      const filename = originalFilename?.toLowerCase() || '';
      
      const specialTypes = {
        // Video formats
        'mp4': 'video/mp4', 'avi': 'video/x-msvideo', 'mov': 'video/quicktime',
        'wmv': 'video/x-ms-wmv', 'flv': 'video/x-flv', 'webm': 'video/webm',
        'mkv': 'video/x-matroska', '3gp': 'video/3gpp', 'm4v': 'video/mp4',
        // Audio formats
        'mp3': 'audio/mpeg', 'wav': 'audio/wav', 'flac': 'audio/flac',
        'aac': 'audio/aac', 'ogg': 'audio/ogg', 'm4a': 'audio/mp4',
        // Document formats
        'html': 'text/html', 'htm': 'text/html', 'txt': 'text/plain',
        'pdf': 'application/pdf', 'doc': 'application/msword',
        'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        // Archive formats
        'zip': 'application/zip', 'rar': 'application/x-rar-compressed',
        '7z': 'application/x-7z-compressed'
      };
      
      for (const [ext, mime] of Object.entries(specialTypes)) {
        if (filename.endsWith(`.${ext}`)) {
          extension = ext;
          mimeType = mime;
          break;
        }
      }
    }

  } catch (error) {
    console.warn('File type detection failed:', error.message);
    // Keep defaults if detection fails
  }

  return { extension, mimeType, detectedType };
}

// Enhanced multer configuration for large files
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
    files: 1,
    fields: 1,
    fieldSize: 100 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    console.log(`Receiving file: ${file.originalname}, mimetype: ${file.mimetype}, size: estimated`);
    cb(null, true);
  }
});

// Enhanced file existence check with retry logic
async function checkFileExistsWithRetry(filename, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const result = await checkFileExists(filename);
      if (result && result.exists) {
        return result;
      }
    } catch (error) {
      console.warn(`File existence check attempt ${i + 1} failed:`, error.message);
      if (i < maxRetries - 1) {
        // Exponential backoff
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
  }
  return null;
}

// Enhanced file retrieval with robust error handling
async function getFileWithRetry(filename, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      console.log(`File retrieval attempt ${i + 1} for: ${filename}`);
      const result = await getFileFromGitHubRobust(filename);
      
      if (result && result.success && result.data) {
        console.log(`Successfully retrieved file: ${filename} (${Math.round(result.size / 1024)}KB)`);
        return result;
      } else {
        console.warn(`Retrieval attempt ${i + 1} failed:`, result?.error || 'Unknown error');
      }
    } catch (error) {
      console.warn(`File retrieval attempt ${i + 1} failed:`, error.message);
    }
    
    if (i < maxRetries - 1) {
      // Exponential backoff with jitter
      const delay = Math.pow(2, i) * 1000 + Math.random() * 1000;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  return null;
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/supported-types', (req, res) => {
  res.json(getSupportedFileTypes());
});

// Enhanced upload endpoint with better progress tracking
app.post('/api/upload', (req, res, next) => {
  // Set longer timeouts for large files
  req.setTimeout(600000); // 10 minutes
  res.setTimeout(600000);
  next();
}, upload.single('file'), async (req, res) => {
  const startTime = Date.now();
  
  try {
    if (!req.file) {
      return res.status(400).json({ 
        error: 'No file uploaded',
        details: 'Please select a file to upload'
      });
    }

    const buffer = req.file.buffer;
    const originalFilename = req.file.originalname;
    
    console.log(`Processing upload: ${originalFilename}, size: ${Math.round(buffer.length / 1024)}KB`);

    if (!buffer || buffer.length === 0) {
      return res.status(400).json({ 
        error: 'Empty file',
        details: 'The uploaded file appears to be empty'
      });
    }

    // Strict size check
    if (buffer.length > 100 * 1024 * 1024) {
      return res.status(413).json({ 
        error: 'File too large',
        details: 'Maximum file size is 100MB',
        maxSize: '100MB',
        receivedSize: `${Math.round(buffer.length / 1024 / 1024)}MB`
      });
    }

    // Enhanced file type detection
    const { extension, mimeType, detectedType } = await detectFileType(buffer, originalFilename);
    
    console.log(`Detected: extension=${extension}, mimeType=${mimeType}, detected=${!!detectedType}`);

    // Upload to GitHub with progress tracking
    console.log('Starting GitHub upload...');
    const uploadResult = await uploadToGitHub(originalFilename, buffer, extension);
    
    if (uploadResult && uploadResult.success) {
      const processingTime = Date.now() - startTime;
      const fileUrl = `${req.protocol}://${req.get('host')}/${uploadResult.filename}`;
      
      const response = {
        success: true,
        filename: uploadResult.filename,
        originalFilename: originalFilename,
        url: fileUrl,
        size: buffer.length,
        sizeFormatted: formatFileSize(buffer.length),
        type: mimeType,
        extension: extension,
        detected: !!detectedType,
        processingTime: processingTime,
        uploadSpeed: Math.round((buffer.length / 1024) / (processingTime / 1000)) // KB/s
      };

      console.log(`Upload successful: ${uploadResult.filename} (${Math.round(processingTime / 1000)}s)`);
      res.json(response);
    } else {
      console.error(`Upload failed: ${uploadResult?.error}`);
      res.status(500).json({ 
        error: 'Upload failed',
        details: uploadResult?.error || 'Unknown error occurred during upload'
      });
    }

  } catch (error) {
    console.error('Upload error:', error);
    
    // Specific error handling
    if (error.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ 
        error: 'File too large',
        details: 'Maximum file size is 100MB'
      });
    } else if (error.message.includes('timeout')) {
      res.status(408).json({ 
        error: 'Upload timeout',
        details: 'File upload took too long. Please try again with a smaller file.'
      });
    } else {
      res.status(500).json({ 
        error: 'Internal server error',
        details: process.env.NODE_ENV === 'development' ? error.message : 'Upload failed'
      });
    }
  }
});

// Enhanced file serving with better range request support
app.get('/:filename', async (req, res) => {
  const startTime = Date.now();
  
  try {
    const filename = req.params.filename;
    
    console.log(`Request for file: ${filename}`);
    
    // Enhanced filename validation
    if (!filename || !isValidFilename(filename)) {
      console.log(`Invalid filename format: ${filename}`);
      return res.status(404).json({ error: 'Invalid filename format' });
    }

    // Set longer timeouts for large files
    req.setTimeout(600000); // 10 minutes
    res.setTimeout(600000);

    // Check if file exists first
    const fileInfo = await checkFileExistsWithRetry(filename);
    if (!fileInfo || !fileInfo.exists) {
      console.log(`File not found: ${filename}`);
      return res.status(404).json({ error: 'File not found' });
    }

    console.log(`File found: ${filename} (${formatFileSize(fileInfo.size)})`);

    // Get file content with retry logic
    const result = await getFileWithRetry(filename);
    
    if (!result || !result.success || !result.data) {
      console.log(`Failed to retrieve file content: ${filename}`);
      return res.status(500).json({ error: 'Failed to retrieve file content' });
    }

    // File type detection
    const extension = path.extname(filename).slice(1).toLowerCase();
    let mimeType = mime.lookup(extension) || 'application/octet-stream';
    
    const isHtmlFile = extension === 'html' || extension === 'htm';
    const forceText = req.query.text === 'true' || req.query.plain === 'true';
    
    if (isHtmlFile || forceText) {
      mimeType = 'text/plain';
      console.log(`Serving HTML file as plain text: ${filename}`);
    }
    
    // Enhanced headers
    const headers = {
      'Content-Type': mimeType,
      'Content-Length': result.data.length,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Access-Control-Allow-Origin': '*',
      'X-File-Name': filename,
      'X-File-Size': result.data.length.toString(),
      'Accept-Ranges': 'bytes',
      'Last-Modified': new Date().toUTCString(),
      'ETag': `"${result.sha || 'unknown'}"`,
      'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length, X-File-Name, X-File-Size'
    };

    // Enhanced range request handling
    const range = req.headers.range;
    if (range && !isHtmlFile && !forceText) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : result.data.length - 1;
      const chunksize = (end - start) + 1;
      
      // Validate range
      if (start >= result.data.length || end >= result.data.length || start > end || start < 0) {
        res.status(416).set({
          'Content-Range': `bytes */${result.data.length}`,
          'Access-Control-Allow-Origin': '*'
        });
        return res.end();
      }
      
      // Update headers for range request
      headers['Content-Range'] = `bytes ${start}-${end}/${result.data.length}`;
      headers['Content-Length'] = chunksize;
      
      console.log(`Serving range: ${start}-${end}/${result.data.length} (${formatFileSize(chunksize)}) for ${filename}`);
      
      res.writeHead(206, headers);
      res.end(result.data.slice(start, end + 1));
      return;
    }

    // Serve complete file
    const responseTime = Date.now() - startTime;
    console.log(`Serving complete file: ${filename} (${formatFileSize(result.data.length)}) in ${responseTime}ms`);
    
    headers['Content-Disposition'] = `inline; filename="${filename}"`;
    headers['X-Response-Time'] = responseTime.toString();
    
    res.set(headers);
    res.send(result.data);

  } catch (error) {
    console.error('File serve error:', error);
    
    if (!res.headersSent) {
      if (error.code === 'ETIMEDOUT' || error.message.includes('timeout')) {
        res.status(408).json({ 
          error: 'Request timeout',
          details: 'File retrieval timed out. The file may be too large or there may be network issues.'
        });
      } else if (error.message.includes('ENOTFOUND') || error.message.includes('network')) {
        res.status(503).json({ 
          error: 'Service unavailable',
          details: 'Unable to connect to file storage. Please try again later.'
        });
      } else {
        res.status(500).json({ 
          error: 'Internal server error',
          details: process.env.NODE_ENV === 'development' ? error.message : 'Failed to serve file'
        });
      }
    }
  }
});

// Enhanced file info endpoint
app.get('/api/info/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    if (!filename || !isValidFilename(filename)) {
      return res.status(404).json({ error: 'Invalid filename format' });
    }

    const result = await getFileInfo(filename);
    
    if (result && result.success) {
      const extension = path.extname(filename).slice(1).toLowerCase();
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      res.json({
        filename: filename,
        size: result.size,
        sizeFormatted: result.sizeFormatted || formatFileSize(result.size),
        type: mimeType,
        extension: extension,
        url: `${req.protocol}://${req.get('host')}/${filename}`,
        textUrl: `${req.protocol}://${req.get('host')}/${filename}?text=true`,
        github_url: result.url,
        sha: result.sha,
        supportsRangeRequests: true,
        isHtml: extension === 'html' || extension === 'htm',
        maxFileSize: '100MB',
        canStream: result.size > 1024 * 1024 // Files > 1MB can be streamed
      });
    } else {
      res.status(404).json({ 
        error: 'File not found',
        details: result?.error || 'File does not exist'
      });
    }
  } catch (error) {
    console.error('File info error:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Enhanced HEAD request handling
app.head('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    if (!filename || !isValidFilename(filename)) {
      return res.status(404).end();
    }

    const result = await checkFileExistsWithRetry(filename);
    
    if (result && result.exists) {
      const extension = path.extname(filename).slice(1).toLowerCase();
      let mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      const isHtmlFile = extension === 'html' || extension === 'htm';
      const forceText = req.query.text === 'true' || req.query.plain === 'true';
      
      if (isHtmlFile || forceText) {
        mimeType = 'text/plain';
      }
      
      res.set({
        'Content-Type': mimeType,
        'Content-Length': result.size,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-File-Name': filename,
        'X-File-Size': result.size.toString(),
        'Accept-Ranges': 'bytes',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'Content-Length, X-File-Name, X-File-Size, Accept-Ranges'
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

// Enhanced health check endpoint
app.get('/api/health', (req, res) => {
  const memUsage = process.memoryUsage();
  
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
    uptime: process.uptime(),
    uptimeFormatted: formatUptime(process.uptime()),
    memory: {
      rss: formatFileSize(memUsage.rss),
      heapTotal: formatFileSize(memUsage.heapTotal),
      heapUsed: formatFileSize(memUsage.heapUsed),
      external: formatFileSize(memUsage.external)
    },
    limits: {
      maxFileSize: '100MB',
      timeout: '10 minutes',
      retries: 3
    },
    features: {
      rangeRequests: true,
      largeFileSupport: true,
      automaticRetry: true,
      typeDetection: true
    }
  });
});

// Enhanced error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ 
        error: 'File too large', 
        details: 'Maximum file size is 100MB',
        maxSize: '100MB',
        code: 'FILE_TOO_LARGE'
      });
    }
    if (error.code === 'LIMIT_UNEXPECTED_FILE') {
      return res.status(400).json({ 
        error: 'Unexpected file',
        details: 'Only single file uploads are supported',
        code: 'UNEXPECTED_FILE'
      });
    }
    return res.status(400).json({ 
      error: 'File upload error',
      details: error.message,
      code: error.code
    });
  }
  
  if (error.type === 'entity.too.large') {
    return res.status(413).json({
      error: 'Payload too large',
      details: 'Request entity exceeds maximum size limit',
      maxSize: '100MB',
      code: 'PAYLOAD_TOO_LARGE'
    });
  }
  
  if (!res.headersSent) {
    res.status(500).json({ 
      error: 'Internal server error',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
      code: 'INTERNAL_ERROR'
    });
  }
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: [
      'GET /',
      'GET /api/health',
      'GET /api/supported-types',
      'POST /api/upload',
      'GET /:filename',
      'GET /api/info/:filename',
      'HEAD /:filename'
    ]
  });
});

// Helper functions
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  
  if (days > 0) return `${days}d ${hours}h ${minutes}m ${secs}s`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

// Start server with enhanced configuration
const server = app.listen(PORT, () => {
  console.log(`🚀 CDN Server running on port ${PORT}`);
  console.log(`📁 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`📊 Max file size: 100MB`);
  console.log(`⏱️  Request timeout: 10 minutes`);
  console.log(`🔄 Retry attempts: 3`);
  console.log(`📄 HTML files served as plain text by default`);
  console.log(`🎯 Large file support: Enabled`);
  console.log(`📡 Range requests: Supported`);
});

// Enhanced server configuration
server.timeout = 600000; // 10 minutes for large files
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.maxConnections = 1000;
server.setMaxListeners(0);

// Graceful shutdown handling
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
