import { Octokit } from '@octokit/rest';
import crypto from 'crypto';

// GitHub configuration
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('Please set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO environment variables');
}

const octokit = new Octokit({
  auth: GITHUB_TOKEN
});

// Generate short filename with J- prefix
function generateShortFilename(buffer, extension, originalFilename = '') {
  // Create short hash (8 characters) from buffer
  const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 8);
  
  // Add timestamp component (4 characters)
  const timestamp = Date.now().toString(36).slice(-4);
  
  // Clean extension - remove dot if present and ensure it's valid
  let cleanExt = extension.toLowerCase();
  if (cleanExt.startsWith('.')) {
    cleanExt = cleanExt.slice(1);
  }
  
  // If no extension detected, try to extract from original filename
  if (!cleanExt || cleanExt === 'bin') {
    const originalExt = originalFilename.split('.').pop();
    if (originalExt && originalExt !== originalFilename) {
      cleanExt = originalExt.toLowerCase();
    }
  }
  
  // Fallback to 'bin' if still no extension
  if (!cleanExt) {
    cleanExt = 'bin';
  }
  
  // Combine: J- + 8char hash + 4char timestamp + extension
  return `J-${hash}${timestamp}.${cleanExt}`;
}

export async function uploadToGitHub(originalFilename, buffer, extension) {
  try {
    // Validate buffer
    if (!buffer || buffer.length === 0) {
      throw new Error('Invalid or empty buffer');
    }

    // Generate short filename
    const filename = generateShortFilename(buffer, extension, originalFilename);
    
    // Convert buffer to base64 - handle large files by chunking if needed
    let content;
    try {
      content = buffer.toString('base64');
    } catch (error) {
      throw new Error('Failed to convert buffer to base64: ' + error.message);
    }
    
    const path = `files/${filename}`;
    
    // Check if file already exists (very unlikely with this naming scheme)
    let sha = null;
    try {
      const { data: existingFile } = await octokit.rest.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: path,
        ref: GITHUB_BRANCH
      });
      sha = existingFile.sha;
    } catch (error) {
      // File doesn't exist, which is fine for new uploads
      if (error.status !== 404) {
        console.warn('Error checking existing file:', error.message);
      }
    }

    // GitHub API has a 100MB limit, check file size before upload
    if (buffer.length > 100 * 1024 * 1024) {
      throw new Error('File too large for GitHub API (max 100MB)');
    }

    const response = await octokit.rest.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      message: `Upload ${filename} (${Math.round(buffer.length / 1024)}KB)`,
      content: content,
      branch: GITHUB_BRANCH,
      ...(sha && { sha })
    });

    return {
      success: true,
      filename: filename,
      originalFilename: originalFilename,
      size: buffer.length,
      data: response.data
    };

  } catch (error) {
    console.error('GitHub upload error:', error);
    return {
      success: false,
      error: error.message || 'Upload failed'
    };
  }
}

export async function getFileFromGitHub(filename) {
  try {
    if (!filename || !isValidFilename(filename)) {
      throw new Error('Invalid filename format');
    }

    const path = `files/${filename}`;
    
    const response = await octokit.rest.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      ref: GITHUB_BRANCH
    });

    if (response.data.content) {
      let buffer;
      try {
        buffer = Buffer.from(response.data.content, 'base64');
      } catch (error) {
        throw new Error('Failed to decode file content');
      }

      return {
        success: true,
        data: buffer,
        size: response.data.size,
        sha: response.data.sha
      };
    } else {
      return {
        success: false,
        error: 'File content not found'
      };
    }

  } catch (error) {
    console.error('GitHub download error:', error);
    return {
      success: false,
      error: error.message || 'Download failed'
    };
  }
}

// Helper function to validate filename format - more flexible for various extensions
export function isValidFilename(filename) {
  // Check if filename matches pattern: J-[8chars][4chars].[ext]
  // Allow alphanumeric extensions of various lengths
  return /^J-[a-f0-9]{8}[a-z0-9]{4}\.[a-zA-Z0-9]{1,10}$/i.test(filename);
}

// Get file info from GitHub without downloading full content
export async function getFileInfo(filename) {
  try {
    if (!filename || !isValidFilename(filename)) {
      throw new Error('Invalid filename format');
    }

    const path = `files/${filename}`;
    
    const response = await octokit.rest.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      ref: GITHUB_BRANCH
    });

    return {
      success: true,
      size: response.data.size,
      sha: response.data.sha,
      url: response.data.download_url,
      name: response.data.name
    };

  } catch (error) {
    console.error('GitHub file info error:', error);
    return {
      success: false,
      error: error.message || 'Failed to get file info'
    };
  }
}

// Helper function to get supported file types
export function getSupportedFileTypes() {
  return {
    video: ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', 'm4v', '3gp'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'ico'],
    document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'],
    code: ['js', 'html', 'css', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'php'],
    other: ['bin', 'exe', 'dmg', 'apk', 'deb', 'rpm']
  };
}
