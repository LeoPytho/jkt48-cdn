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
function generateShortFilename(buffer, extension) {
  // Create short hash (8 characters) from buffer
  const hash = crypto.createHash('md5').update(buffer).digest('hex').substring(0, 8);
  
  // Add timestamp component (4 characters)
  const timestamp = Date.now().toString(36).slice(-4);
  
  // Combine: J- + 8char hash + 4char timestamp + extension
  return `J-${hash}${timestamp}.${extension}`;
}

export async function uploadToGitHub(originalFilename, buffer, extension) {
  try {
    // Generate short filename
    const filename = generateShortFilename(buffer, extension);
    
    const content = buffer.toString('base64');
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
    }

    const response = await octokit.rest.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      message: `Upload ${filename}`,
      content: content,
      branch: GITHUB_BRANCH,
      ...(sha && { sha })
    });

    return {
      success: true,
      filename: filename, // Return the generated filename
      data: response.data
    };

  } catch (error) {
    console.error('GitHub upload error:', error);
    return {
      success: false,
      error: error.message
    };
  }
}

export async function getFileFromGitHub(filename) {
  try {
    const path = `files/${filename}`;
    
    const response = await octokit.rest.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: path,
      ref: GITHUB_BRANCH
    });

    if (response.data.content) {
      const buffer = Buffer.from(response.data.content, 'base64');
      return {
        success: true,
        data: buffer
      };
    } else {
      return {
        success: false,
        error: 'File content not found'
      };
    }

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// Helper function to validate filename format
export function isValidFilename(filename) {
  // Check if filename matches pattern: J-[8chars][4chars].[ext]
  return /^J-[a-f0-9]{8}[a-z0-9]{4}\.[a-zA-Z0-9]+$/i.test(filename);
}

// Get file info from GitHub without downloading full content
export async function getFileInfo(filename) {
  try {
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
      url: response.data.download_url
    };

  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}
