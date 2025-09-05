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
const PERPLEXITY_API_KEY = process.env.PERPLEXITY_API_KEY;

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    success: true, 
    message: 'EMORECO Backend is running',
    timestamp: new Date().toISOString(),
    services: {
      assemblyAI: !!ASSEMBLYAI_API_KEY,
      huggingFace: !!HUGGING_FACE_TOKEN,
      perplexityAI: !!PERPLEXITY_API_KEY
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

    // Step 1: Process with AssemblyAI and Hugging Face in parallel
    console.log('Processing with AssemblyAI and Hugging Face...');
    const [assemblyResult, huggingResult] = await Promise.all([
      processWithAssemblyAI(audioFile.buffer),
      processWithHuggingFace(audioFile.buffer).catch(error => {
        console.warn('Hugging Face processing failed:', error.message);
        return { error: error.message };
      })
    ]);
    
    // Step 2: Process with Perplexity AI for detailed analysis
    let perplexityResult = null;
    if (PERPLEXITY_API_KEY) {
      try {
        console.log('Processing with Perplexity AI...');
        perplexityResult = await processWithPerplexity(assemblyResult, huggingResult);
      } catch (pplxError) {
        console.warn('Perplexity AI processing failed:', pplxError.message);
        perplexityResult = { error: pplxError.message };
      }
    }

    // Step 3: Return combined results
    console.log('Analysis completed successfully');
    res.json({
      success: true,
      transcript: assemblyResult.text,
      audioMetrics: {
        wordsPerMinute: calculateWPM(assemblyResult.text, assemblyResult.audio_duration),
        confidence: assemblyResult.confidence,
        audioDuration: assemblyResult.audio_duration,
        sentiment: assemblyResult.sentiment_analysis_results || null
      },
      emotions: huggingResult,
      detailedAnalysis: perplexityResult
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
async function processWithHuggingFace(audioBuffer) {
  if (!HUGGING_FACE_TOKEN) {
    throw new Error('Hugging Face not configured');
  }

  try {
    // For audio emotion detection, we would typically use a different model
    // This is a placeholder for the actual implementation
    const response = await axios.post(
      'https://api-inference.huggingface.co/models/superb/hubert-large-superb-er',
      audioBuffer,
      {
        headers: {
          'Authorization': `Bearer ${HUGGING_FACE_TOKEN}`,
          'Content-Type': 'audio/flac'
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

// Perplexity AI processing function for detailed analysis
async function processWithPerplexity(assemblyResult, huggingResult) {
  if (!PERPLEXITY_API_KEY) {
    throw new Error('Perplexity AI not configured');
  }

  try {
    // Prepare the detailed prompt for Perplexity analysis
    const detailedAnalysisPrompt = `
DETAILED AI ANALYSIS REQUEST:

ANALYSIS DATA:
{
  "TRANSCRIPT": "${assemblyResult.text}",
  
  "AUDIO_INTELLIGENCE": {
    "speech_metrics": ${JSON.stringify({
      wordsPerMinute: calculateWPM(assemblyResult.text, assemblyResult.audio_duration),
      confidence: assemblyResult.confidence,
      audioDuration: assemblyResult.audio_duration
    })},
    "sentiment_analysis": ${JSON.stringify(assemblyResult.sentiment_analysis_results || {})}
  },
  
  "EMOTION_ANALYSIS": ${JSON.stringify(huggingResult)}
}

ANALYSIS INSTRUCTIONS:

1. EMOTIONAL TRUTH ASSESSMENT:
   - Identify surface emotions vs hidden true emotions
   - Detect emotional contradictions between words and voice
   - Analyze emotional consistency throughout speech

2. VERACITY & HONESTY ANALYSIS:
   - Look for deception indicators in vocal patterns
   - Identify stress cues that suggest lying
   - Analyze speech patterns for truthfulness

3. COMMUNICATION INTENT DETECTION:
   - Determine if intent is: Educate, Persuade, Manipulate, Deceive
   - Identify persuasion techniques being used
   - Detect hidden agendas or ulterior motives

4. PSYCHOLOGICAL PROFILE:
   - Analyze personality traits from speech patterns
   - Identify emotional state stability
   - Detect anxiety, confidence, or narcissism indicators

5. MANIPULATION ASSESSMENT:
   - Check for brainwashing techniques
   - Identify emotional manipulation patterns
   - Detect gaslighting or psychological pressure

6. CULTURAL & CONTEXTUAL ANALYSIS:
   - Consider cultural influences on communication style
   - Analyze context-appropriate vs inappropriate responses
   - Identify cultural truth-telling patterns

7. RISK ASSESSMENT:
   - Evaluate trustworthiness level
   - Identify potential red flags
   - Provide confidence scores for each assessment

REQUIRED OUTPUT FORMAT:
- Comprehensive psychological assessment report
- Section-wise analysis with evidence from data
- Confidence levels for each finding
- Overall truthfulness score (0-100%)
- Recommended actions or precautions
`;

    // Call Perplexity API
    const response = await axios.post(
      'https://api.perplexity.ai/chat/completions',
      {
        model: 'sonar-reasoning',
        messages: [
          {
            role: 'system',
            content: 'You are an expert psychologist and voice analysis specialist. Analyze the provided voice data and provide a comprehensive truthfulness and psychological assessment.'
          },
          {
            role: 'user',
            content: detailedAnalysisPrompt
          }
        ],
        temperature: 0.2,
        max_tokens: 2000
      },
      {
        headers: {
          'Authorization': `Bearer ${PERPLEXITY_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    return response.data;
  } catch (error) {
    console.error('Perplexity AI error:', error.message);
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
