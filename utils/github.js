import { Octokit } from '@octokit/rest';

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

export async function uploadToGitHub(filename, buffer) {
  try {
    const content = buffer.toString('base64');
    const path = `files/${filename}`;
    
    // Check if file already exists
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
