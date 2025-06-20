import { Octokit } from '@octokit/rest';
import crypto from 'crypto';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';

if (!GITHUB_TOKEN || !GITHUB_OWNER || !GITHUB_REPO) {
  console.error('Please set GITHUB_TOKEN, GITHUB_OWNER, and GITHUB_REPO environment variables');
}

const octokit = new Octokit({
  auth: GITHUB_TOKEN,
  request: {
    timeout: 300000, // 5 minutes timeout for large files
    retries: 3
  }
});

function generateShortFilename(buffer, extension, originalFilename = '') {
  const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 8);
  const timestamp = Date.now().toString(36).slice(-4);
  
  let cleanExt = extension.toLowerCase();
  if (cleanExt.startsWith('.')) cleanExt = cleanExt.slice(1);
  
  if (!cleanExt || cleanExt === 'bin') {
    const originalExt = originalFilename.split('.').pop();
    if (originalExt && originalExt !== originalFilename) {
      cleanExt = originalExt.toLowerCase();
    }
  }
  
  if (!cleanExt) cleanExt = 'bin';
  return `J-${hash}${timestamp}.${cleanExt}`;
}

export async function uploadToGitHub(originalFilename, buffer, extension) {
  try {
    if (!buffer || buffer.length === 0) {
      throw new Error('Invalid or empty buffer');
    }

    if (buffer.length > 100 * 1024 * 1024) {
      throw new Error('File too large for GitHub API (max 100MB)');
    }

    const filename = generateShortFilename(buffer, extension, originalFilename);
    const content = buffer.toString('base64');
    const path = `files/${filename}`;
    
    // Check existing file
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
      if (error.status !== 404) {
        console.warn('Error checking existing file:', error.message);
      }
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
    
    // First, get file metadata to check size and get download URL
    const metadataResponse = await octokit.rest.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      ref: GITHUB_BRANCH
    });

    const fileData = metadataResponse.data;
    
    // GitHub Contents API limit is 1MB for base64 content
    // For files larger than 1MB, we must use the download_url
    let buffer;
    
    if (fileData.size > 1024 * 1024 || !fileData.content) {
      // Use download URL for large files or when content is not available
      if (!fileData.download_url) {
        throw new Error('File too large and no download URL available');
      }
      
      console.log(`Downloading large file (${Math.round(fileData.size / 1024)}KB) via download URL...`);
      
      const downloadResponse = await fetch(fileData.download_url, {
        headers: {
          'Authorization': `token ${GITHUB_TOKEN}`,
          'User-Agent': 'GitHub-File-Handler',
          'Accept': 'application/vnd.github.v3.raw'
        },
        timeout: 300000 // 5 minutes timeout
      });
      
      if (!downloadResponse.ok) {
        throw new Error(`Download failed: ${downloadResponse.status} ${downloadResponse.statusText}`);
      }
      
      const arrayBuffer = await downloadResponse.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
      
    } else {
      // For smaller files, use base64 content directly
      console.log(`Reading small file (${Math.round(fileData.size / 1024)}KB) from base64 content...`);
      
      if (!fileData.content) {
        throw new Error('File content not available');
      }
      
      buffer = Buffer.from(fileData.content, 'base64');
    }

    // Verify file size matches
    if (buffer.length !== fileData.size) {
      console.warn(`File size mismatch: expected ${fileData.size}, got ${buffer.length}`);
    }

    return {
      success: true,
      data: buffer,
      size: buffer.length,
      sha: fileData.sha,
      actualSize: fileData.size
    };

  } catch (error) {
    console.error('GitHub download error:', error);
    return {
      success: false,
      error: error.message || 'Download failed'
    };
  }
}

// Alternative method using Git Data API for very large files
export async function getFileFromGitHubGitData(filename) {
  try {
    if (!filename || !isValidFilename(filename)) {
      throw new Error('Invalid filename format');
    }

    const path = `files/${filename}`;
    
    // Get the file's blob SHA using the tree API
    const { data: treeData } = await octokit.rest.git.getTree({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      tree_sha: GITHUB_BRANCH,
      recursive: true
    });
    
    const fileEntry = treeData.tree.find(item => item.path === path);
    if (!fileEntry) {
      throw new Error('File not found');
    }
    
    // Get the blob data
    const { data: blobData } = await octokit.rest.git.getBlob({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      file_sha: fileEntry.sha
    });
    
    const buffer = Buffer.from(blobData.content, blobData.encoding);
    
    return {
      success: true,
      data: buffer,
      size: buffer.length,
      sha: fileEntry.sha
    };

  } catch (error) {
    console.error('GitHub Git Data API error:', error);
    return {
      success: false,
      error: error.message || 'Download failed'
    };
  }
}

// Enhanced function that tries multiple methods
export async function getFileFromGitHubRobust(filename) {
  console.log(`Attempting to download file: ${filename}`);
  
  // Try the standard method first
  let result = await getFileFromGitHub(filename);
  
  if (!result.success && result.error.includes('too large')) {
    console.log('Standard method failed for large file, trying Git Data API...');
    result = await getFileFromGitHubGitData(filename);
  }
  
  return result;
}

export function isValidFilename(filename) {
  return /^J-[a-f0-9]{8}[a-z0-9]{4}\.[a-zA-Z0-9]{1,10}$/i.test(filename);
}

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
      name: response.data.name,
      sizeFormatted: formatFileSize(response.data.size)
    };

  } catch (error) {
    console.error('GitHub file info error:', error);
    return {
      success: false,
      error: error.message || 'Failed to get file info'
    };
  }
}

// Helper function to format file size
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Function to check if file exists and get basic info quickly
export async function checkFileExists(filename) {
  try {
    if (!filename || !isValidFilename(filename)) {
      return { exists: false, error: 'Invalid filename format' };
    }

    const path = `files/${filename}`;
    
    // Use HEAD request equivalent to check if file exists without downloading content
    const response = await octokit.rest.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      ref: GITHUB_BRANCH
    });

    return {
      exists: true,
      size: response.data.size,
      sha: response.data.sha,
      downloadUrl: response.data.download_url
    };

  } catch (error) {
    if (error.status === 404) {
      return { exists: false };
    }
    return { exists: false, error: error.message };
  }
}

export function getSupportedFileTypes() {
  return {
    video: ['mp4', 'avi', 'mov', 'wmv', 'flv', 'webm', 'mkv', 'm4v', '3gp', 'mp2', 'mpe', 'mpeg', 'mpg', 'mpv2', 'm2v'],
    audio: ['mp3', 'wav', 'flac', 'aac', 'ogg', 'wma', 'm4a', 'opus', 'aiff', 'au', 'ra'],
    image: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'webp', 'tiff', 'tif', 'ico', 'heic', 'heif'],
    document: ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'txt', 'rtf', 'odt', 'ods', 'odp'],
    archive: ['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'lz', 'lzma'],
    code: ['js', 'html', 'css', 'json', 'xml', 'py', 'java', 'cpp', 'c', 'php', 'rb', 'go', 'rs', 'ts'],
    other: ['bin', 'exe', 'dmg', 'apk', 'deb', 'rpm', 'msi', 'pkg']
  };
}

// Usage example:
// const result = await getFileFromGitHubRobust('J-a1b2c3d4ef56.mp4');
// if (result.success) {
//   console.log(`Downloaded ${formatFileSize(result.size)} successfully`);
//   // Use result.data (Buffer) here
// } else {
//   console.error('Download failed:', result.error);
// }
