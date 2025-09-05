const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();

// Configure multer for memory storage
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  }
});

// Middleware
app.use(express.json());

// Environment variables
const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;
const HUGGING_FACE_TOKEN = process.env.HUGGING_FACE_TOKEN;
const IBM_WATSON_API_KEY = process.env.IBM_WATSON_API_KEY;
const IBM_WATSON_URL = process.env.IBM_WATSON_URL;

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'EMORECO Backend is running',
    timestamp: new Date().toISOString(),
    services: {
      assemblyAI: !!ASSEMBLYAI_API_KEY,
      huggingFace: !!HUGGING_FACE_TOKEN,
      ibmWatson: !!IBM_WATSON_API_KEY
    }
  });
});

// Main analysis endpoint
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

    // Check if API keys are configured
    if (!ASSEMBLYAI_API_KEY) {
      return res.status(500).json({
        success: false,
        error: 'AssemblyAI API key not configured'
      });
    }

    // Step 1: Upload to AssemblyAI and get transcript
    console.log('Uploading to AssemblyAI...');
    const assemblyResult = await processWithAssemblyAI(audioFile.buffer);
    
    // Step 2: Process with Hugging Face (if configured)
    let huggingResult = null;
    if (HUGGING_FACE_TOKEN) {
      try {
        console.log('Processing with Hugging Face...');
        huggingResult = await processWithHuggingFace(assemblyResult.text);
      } catch (hfError) {
        console.warn('Hugging Face processing failed:', hfError.message);
        huggingResult = { error: hfError.message };
      }
    }

    // Step 3: Process with IBM Watson (if configured)
    let ibmResult = null;
    if (IBM_WATSON_API_KEY && IBM_WATSON_URL) {
      try {
        console.log('Processing with IBM Watson...');
        ibmResult = await processWithIBMWatson(assemblyResult.text);
      } catch (ibmError) {
        console.warn('IBM Watson processing failed:', ibmError.message);
        ibmResult = { error: ibmError.message };
      }
    }

    // Step 4: Return combined results
    console.log('Analysis completed successfully');
    res.json({
      success: true,
      transcript: assemblyResult.text,
      audioMetrics: {
        wordsPerMinute: calculateWPM(assemblyResult.text, assemblyResult.audio_duration),
        confidence: assemblyResult.confidence,
        audioDuration: assemblyResult.audio_duration
      },
      emotions: huggingResult,
      tones: ibmResult,
      sentiment: assemblyResult.sentiment_analysis_results || null
    });

  } catch (error) {
    console.error('Analysis error:', error.message);
    
    if (error.response) {
      console.error('API response error:', error.response.data);
    }
    
    res.status(500).json({
      success: false,
      error: error.message || 'Internal server error',
      details: error.response?.data || null
    });
  }
});

// AssemblyAI processing function
async function processWithAssemblyAI(audioBuffer) {
  try {
    // First upload the audio file
    const uploadResponse = await axios.post(
      'https://api.assemblyai.com/v2/upload',
      audioBuffer,
      {
        headers: {
          'authorization': ASSEMBLYAI_API_KEY,
          'content-type': 'application/octet-stream'
        },
        timeout: 30000
      }
    );

    const audioUrl = uploadResponse.data.upload_url;
    console.log('Audio uploaded, URL:', audioUrl);

    // Then start transcription
    const transcriptionResponse = await axios.post(
      'https://api.assemblyai.com/v2/transcript',
      {
        audio_url: audioUrl,
        sentiment_analysis: true,
        language_code: 'en'
      },
      {
        headers: {
          'authorization': ASSEMBLYAI_API_KEY,
          'content-type': 'application/json'
        },
        timeout: 30000
      }
    );

    const transcriptId = transcriptionResponse.data.id;
    console.log('Transcription ID:', transcriptId);

    // Poll for results
    let result;
    let attempts = 0;
    const maxAttempts = 30;
    
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const checkResponse = await axios.get(
        `https://api.assemblyai.com/v2/transcript/${transcriptId}`,
        {
          headers: {
            'authorization': ASSEMBLYAI_API_KEY
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
      throw new Error(result.error || 'Audio processing failed');
    }

    if (attempts >= maxAttempts) {
      throw new Error('Processing timeout - audio too long or server busy');
    }

    return result;
  } catch (error) {
    console.error('AssemblyAI processing error:', error.message);
    throw error;
  }
}

// Hugging Face processing function
async function processWithHuggingFace(text) {
  if (!HUGGING_FACE_TOKEN) {
    return { error: 'Hugging Face not configured' };
  }

  try {
    const response = await axios.post(
      'https://api-inference.huggingface.co/models/j-hartmann/emotion-english-distilroberta-base',
      { inputs: text },
      {
        headers: {
          'Authorization': `Bearer ${HUGGING_FACE_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    return response.data;
  } catch (error) {
    console.error('Hugging Face error:', error.message);
    throw error;
  }
}

// IBM Watson processing function
async function processWithIBMWatson(text) {
  if (!IBM_WATSON_API_KEY || !IBM_WATSON_URL) {
    return { error: 'IBM Watson not configured' };
  }

  try {
    const response = await axios.post(
      `${IBM_WATSON_URL}/v3/tone?version=2017-09-21`,
      { text: text },
      {
        headers: {
          'Authorization': `Basic ${Buffer.from(`apikey:${IBM_WATSON_API_KEY}`).toString('base64')}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    return response.data;
  } catch (error) {
    console.error('IBM Watson error:', error.message);
    throw error;
  }
}

// Helper function to calculate words per minute
function calculateWPM(text, audioDuration) {
  if (!audioDuration || audioDuration === 0) return 0;
  
  const words = text.split(/\s+/).length;
  const minutes = audioDuration / 60;
  return Math.round(words / minutes);
}

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
