<?php
header('Access-Control-Allow-Origin: *');
header('Access-Control-Allow-Methods: GET, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Method not allowed']);
    exit;
}

// Konfigurasi
define('DATA_DIR', dirname(__DIR__) . '/data/');

// Validasi parameter ID
if (!isset($_GET['id']) || empty($_GET['id'])) {
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'File ID required']);
    exit;
}

$fileId = preg_replace('/[^a-f0-9]/', '', $_GET['id']); // Sanitasi input

if (strlen($fileId) !== 16) { // Ubah dari 32 ke 16
    http_response_code(400);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Invalid file ID']);
    exit;
}

// Load metadata
$metadataFile = DATA_DIR . $fileId . '.json';

if (!file_exists($metadataFile)) {
    http_response_code(404);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'File not found']);
    exit;
}

$metadataContent = file_get_contents($metadataFile);
if ($metadataContent === false) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Failed to read metadata']);
    exit;
}

$metadata = json_decode($metadataContent, true);

if (!$metadata || !isset($metadata['url'])) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Invalid metadata']);
    exit;
}

// Dapatkan extension dari metadata
$extension = isset($metadata['ext']) ? strtolower($metadata['ext']) : '';
$originalName = $metadata['name'] ?? 'file';

// Cek apakah request info saja (JSON)
if (isset($_GET['info'])) {
    header('Content-Type: application/json');
    echo json_encode([
        'filename' => $originalName,
        'size' => $metadata['size'] ?? 0,
        'extension' => $extension
    ]);
    exit;
}

// Proxy file dari CDN eksternal
$externalUrl = $metadata['url'];

// Fetch headers dari CDN provider untuk mendeteksi Content-Type dan Content-Disposition
$ch = curl_init($externalUrl);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_HEADER => true,
    CURLOPT_NOBODY => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_HTTPHEADER => [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    ]
]);

$response = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

// Parse headers dari CDN provider
$providerContentType = null;
$providerDisposition = null;

if ($httpCode === 200 && $response) {
    $headerLines = explode("\r\n", $response);
    foreach ($headerLines as $line) {
        if (stripos($line, 'Content-Type:') === 0) {
            $providerContentType = trim(substr($line, 13));
        }
        if (stripos($line, 'Content-Disposition:') === 0) {
            $providerDisposition = trim(substr($line, 20));
        }
    }
}

// Set headers mengikuti CDN provider
if ($providerContentType) {
    header('Content-Type: ' . $providerContentType);
} else {
    // Fallback jika CDN tidak memberikan Content-Type
    header('Content-Type: ' . ($metadata['mime_type'] ?? 'application/octet-stream'));
}

if ($providerDisposition) {
    // Gunakan Content-Disposition dari CDN provider, tapi ganti filename dengan original
    if (stripos($providerDisposition, 'attachment') !== false) {
        header('Content-Disposition: attachment; filename="' . addslashes($originalName) . '"');
    } else {
        header('Content-Disposition: inline; filename="' . addslashes($originalName) . '"');
    }
} else {
    // Fallback: default inline
    header('Content-Disposition: inline; filename="' . addslashes($originalName) . '"');
}

header('Accept-Ranges: bytes');
header('Cache-Control: public, max-age=31536000');

// Initialize cURL untuk fetch file dari CDN eksternal
$ch = curl_init($externalUrl);

// Check if Range header is present (untuk streaming video)
$headers = [];
$isRangeRequest = false;

if (isset($_SERVER['HTTP_RANGE'])) {
    $headers[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
    $isRangeRequest = true;
}

curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER => false,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_TIMEOUT => 300,
    CURLOPT_HTTPHEADER => array_merge($headers, [
        'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    ]),
    CURLOPT_WRITEFUNCTION => function($ch, $data) {
        echo $data;
        if (ob_get_level() > 0) {
            ob_flush();
        }
        flush();
        return strlen($data);
    },
    CURLOPT_HEADERFUNCTION => function($ch, $header) use ($isRangeRequest) {
        $len = strlen($header);
        $header = trim($header);
        
        if (empty($header) || strpos($header, 'HTTP/') === 0) {
            return $len;
        }
        
        $parts = explode(':', $header, 2);
        if (count($parts) === 2) {
            $headerName = strtolower(trim($parts[0]));
            $headerValue = trim($parts[1]);
            
            // Forward important headers
            $forwardHeaders = [
                'content-length',
                'content-range',
                'etag',
                'last-modified'
            ];
            
            if (in_array($headerName, $forwardHeaders)) {
                header($header);
            }
        }
        
        return $len;
    }
]);

// Set HTTP status untuk range requests
if ($isRangeRequest) {
    http_response_code(206); // Partial Content
}

// Disable output buffering untuk streaming
if (ob_get_level()) {
    ob_end_clean();
}

// Execute
$result = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$error = curl_error($ch);
curl_close($ch);

if (!$result && $httpCode >= 400) {
    http_response_code(500);
    header('Content-Type: application/json');
    echo json_encode([
        'error' => 'Failed to retrieve file from CDN',
        'http_code' => $httpCode
    ]);
}

exit;