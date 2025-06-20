import express from 'express';
import multer from 'multer';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { fileTypeFromBuffer } from 'file-type';
import { uploadToGitHub, getFileFromGitHub, isValidFilename, getFileInfo } from './utils/github.js';
import mime from 'mime-types';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Multer configuration for file upload
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow all file types
    cb(null, true);
  }
});

// Serve homepage
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint for file upload
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const buffer = req.file.buffer;
    
    // Detect file type
    let fileType = await fileTypeFromBuffer(buffer);
    let extension = fileType ? fileType.ext : 'bin';
    
    // If file type detection fails, try to get from original name
    if (!fileType && req.file.originalname) {
      const originalExt = path.extname(req.file.originalname).slice(1);
      if (originalExt) {
        extension = originalExt.toLowerCase();
      }
    }

    // Upload to GitHub (the function will generate short filename internally)
    const result = await uploadToGitHub(req.file.originalname, buffer, extension);
    
    if (result.success) {
      const fileUrl = `${req.protocol}://${req.get('host')}/${result.filename}`;
      res.json({
        success: true,
        filename: result.filename, // Use the generated short filename
        url: fileUrl,
        size: buffer.length,
        type: fileType ? fileType.mime : mime.lookup(extension) || 'application/octet-stream'
      });
    } else {
      res.status(500).json({ error: result.error });
    }

  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve files from GitHub
app.get('/:filename', async (req, res) => {
  try {
    const filename = req.params.filename;
    
    // Validate filename format
    if (!isValidFilename(filename)) {
      return res.status(404).json({ error: 'File not found' });
    }

    const result = await getFileFromGitHub(filename);
    
    if (result.success) {
      const extension = path.extname(filename).slice(1);
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      res.set({
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${filename}"`,
        'Cache-Control': 'public, max-age=31536000', // 1 year cache
        'Access-Control-Allow-Origin': '*',
        'X-File-Name': filename
      });
      
      res.send(result.data);
    } else {
      res.status(404).json({ error: 'File not found' });
    }

  } catch (error) {
    console.error('File serve error:', error);
    res.status(500).json({ error: 'Internal server error' });
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
      const extension = path.extname(filename).slice(1);
      const mimeType = mime.lookup(extension) || 'application/octet-stream';
      
      res.json({
        filename: filename,
        size: result.size,
        type: mimeType,
        url: `${req.protocol}://${req.get('host')}/${filename}`,
        github_url: result.url
      });
    } else {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to check if file exists
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
        'X-File-Name': filename
      });
      
      res.status(200).end();
    } else {
      res.status(404).end();
    }
  } catch (error) {
    res.status(500).end();
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 100MB.' });
    }
  }
  
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`CDN Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});
