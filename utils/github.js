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
    timeout: 1200000, // 2 minutes timeout
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
    
    // Use download_url for large files to avoid base64 conversion issues
    const response = await octokit.rest.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      ref: GITHUB_BRANCH
    });

    if (!response.data.content && !response.data.download_url) {
      throw new Error('File content not available');
    }

    let buffer;
    if (response.data.size > 1024 * 1024) { // For files > 1MB, use download_url
      const downloadResponse = await fetch(response.data.download_url);
      if (!downloadResponse.ok) {
        throw new Error(`Download failed: ${downloadResponse.statusText}`);
      }
      const arrayBuffer = await downloadResponse.arrayBuffer();
      buffer = Buffer.from(arrayBuffer);
    } else {
      // For smaller files, use base64 content
      buffer = Buffer.from(response.data.content, 'base64');
    }

    return {
      success: true,
      data: buffer,
      size: buffer.length,
      sha: response.data.sha
    };

  } catch (error) {
    console.error('GitHub download error:', error);
    return {
      success: false,
      error: error.message || 'Download failed'
    };
  }
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
