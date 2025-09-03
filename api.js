const express = require('express');
const cors = require('cors');
const multer = require('multer');
const axios = require('axios');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// In-memory storage for multer
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// AssemblyAI API Integration
app.post('/api/analyze-audio', upload.single('audio'), async (req, res) => {
  try {
    console.log('Audio analysis request received');
    
    const audioFile = req.file;
    
    if (!audioFile) {
      return res.status(400).json({ 
        success: false,
        error: 'No audio file provided' 
      });
    }

    // Get API key from environment variable
    const assemblyAIKey = process.env.ASSEMBLYAI_API_KEY;
    
    if (!assemblyAIKey) {
      return res.status(500).json({
        success: false,
        error: 'Server configuration error'
      });
    }

    // Step 1: Upload audio to AssemblyAI
    console.log('Uploading audio to AssemblyAI...');
    const uploadResponse = await axios.post(
      'https://api.assemblyai.com/v2/upload',
      audioFile.buffer,
      {
        headers: {
          'authorization': assemblyAIKey,
          'content-type': 'audio/wav'
        },
        timeout: 30000 // 30 seconds timeout
      }
    );

    const audioUrl = uploadResponse.data.upload_url;
    console.log('Audio uploaded, URL:', audioUrl);

    // Step 2: Start transcription with sentiment analysis
    console.log('Starting transcription...');
    const transcriptionResponse = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      {
        audio_url: audioUrl,
        sentiment_analysis: true,
        language_code: 'en' // English language
      },
      {
        headers: {
          'authorization': assemblyAIKey,
          'content-type': 'application/json'
        },
        timeout: 30000
      }
    );

    const transcriptId = transcriptionResponse.data.id;
    console.log('Transcription ID:', transcriptId);

    // Step 3: Poll for results
    console.log('Polling for results...');
    let result;
    let attempts = 0;
    const maxAttempts = 30; // 30 attempts * 3 seconds = 90 seconds max
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const checkResponse = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: {
            'authorization': assemblyAIKey
          },
          timeout: 30000
        }
      );

      result = checkResponse.data;
      console.log(`Attempt ${attempts + 1}: Status - ${result.status}`);

      if (result.status === 'completed' || result.status === 'error') {
        break;
      }

      attempts++;
    }

    if (result.status === 'error') {
      console.error('Transcription error:', result.error);
      return res.status(500).json({
        success: false,
        error: 'Audio processing failed: ' + (result.error || 'Unknown error')
      });
    }

    if (attempts >= maxAttempts) {
      return res.status(500).json({
        success: false,
        error: 'Processing timeout - audio too long or server busy'
      });
    }

    // Step 4: Return sentiment analysis results
    console.log('Analysis completed successfully');
    res.json({
      success: true,
      text: result.text,
      sentiments: result.sentiment_analysis_results || []
    });

  } catch (error) {
    console.error('AssemblyAI API Error:', error.message);
    
    if (error.response) {
      console.error('API Response error:', error.response.data);
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error'
    });
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'EMORECO Backend is running',
    timestamp: new Date().toISOString()
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: 'EMORECO Backend API',
    endpoints: {
      health: '/api/health',
      analyze: '/api/analyze-audio (POST)'
    }
  });
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found'
  });
});

// Export for Vercel
module.exports = app;

// For local testing
if (require.main === module) {
  const PORT = process.env.PORT || 3001;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
