import fetch from 'node-fetch';
import FormData from 'form-data';
import { fileTypeFromBuffer } from 'file-type';

/**
 * Upload file to your CDN (Compatible with short J- filenames)
 * @param {Buffer} buffer File Buffer
 * @param {string} baseUrl Your CDN base URL (e.g., 'https://yourcdn.vercel.app')
 * @returns {Promise<string>} File URL
 */
export default async function uploadImage(buffer, baseUrl) {
  try {
    let { ext } = await fileTypeFromBuffer(buffer) || { ext: 'bin' };
    let bodyForm = new FormData();
    bodyForm.append("file", buffer, "file." + ext);

    let res = await fetch(`https://cdn.jkt48connect.my.id/api/upload`, {
      method: "POST",
      body: bodyForm,
    });

    let data = await res.json();
    
    if (data.success) {
      return data.url; // Returns URL with short J- filename
    } else {
      throw new Error(data.error || 'Upload failed');
    }
  } catch (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }
}

/**
 * Get file info from CDN
 * @param {string} filename Short filename (e.g., 'J-a1b2c3d4e5f6.jpg')
 * @param {string} baseUrl Your CDN base URL
 * @returns {Promise<Object>} File info
 */
export async function getFileInfo(filename, baseUrl) {
  try {
    let res = await fetch(`https://cdn.jkt48connect.my.id/api/info/${filename}`);
    
    if (res.ok) {
      return await res.json();
    } else {
      throw new Error('File not found');
    }
  } catch (error) {
    throw new Error(`Get file info failed: ${error.message}`);
  }
}

/**
 * Check if file exists
 * @param {string} filename Short filename
 * @param {string} baseUrl Your CDN base URL
 * @returns {Promise<boolean>} File exists
 */
export async function fileExists(filename, baseUrl) {
  try {
    let res = await fetch(`https://cdn.jkt48connect.my.id/${filename}`, { method: 'HEAD' });
    return res.ok;
  } catch (error) {
    return false;
  }
}