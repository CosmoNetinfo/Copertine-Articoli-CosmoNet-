import { GoogleGenAI, Type } from "@google/genai";
import { AnalysisResult } from "../types";

const MANDATORY_STYLE = "Hyper-realistic cyberpunk 3D style, cinematic lighting, dramatic neon glows (cyan, magenta, electric blue), high contrast, surreal futuristic tech theme, intricate digital details, 16:9";

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 10, initialDelay = 5000): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const errorString = JSON.stringify(err).toLowerCase();

      // Controlla immediatamente se l'errore è dovuto a permessi negati (403 PERMISSION_DENIED)
      const isPermissionDenied =
        err.status === 403 ||
        err.code === 403 ||
        errorString.includes('403') ||
        errorString.includes('permission_denied') ||
        errorString.includes('not have permission') ||
        errorString.includes('caller does not have permission');

      if (isPermissionDenied) {
        throw err; // Fornisce l'errore originale per permettere al chiamante di personalizzare la risposta
      }

      const isRateLimit = 
        err.status === 429 || 
        err.code === 429 ||
        errorString.includes('429') || 
        errorString.includes('rate_limit') || 
        errorString.includes('resource_exhausted') ||
        errorString.includes('quota');
      
      if (isRateLimit && i < maxRetries - 1) {
        // More aggressive exponential backoff: 5s, 10s, 20s, 40s...
        const delay = initialDelay * Math.pow(2, i) + (Math.random() * 2000);
        console.warn(`Lavoro intenso per Gemini... (Limite 429). Attesa di sicurezza: ${Math.round(delay/1000)} secondi. Tentativo ${i + 1}/${maxRetries}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Retry also on specific "empty response" or "text instead of image" errors for images
      const isImageFluke = 
        errorString.includes('empty text part') || 
        errorString.includes('text message instead of an image') ||
        errorString.includes('no image data found');

      if (isImageFluke && i < maxRetries - 1) {
        const delay = 2000 + (Math.random() * 1000);
        console.warn(`Risposta IA incompleta. Nuovo tentativo rapido tra ${Math.round(delay)}ms... (Tentativo ${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      throw err;
    }
  }
  throw lastError;
}

export async function analyzeArticle(html: string, customApiKey?: string, openrouterApiKey?: string): Promise<AnalysisResult> {
  const systemKey = process.env.GEMINI_API_KEY;
  const geminiKey = (customApiKey || systemKey || "").trim();

  // Preferiamo Gemini (custom o di sistema) se disponibile con una lista di modelli di fallback
  if (geminiKey) {
    const ai = new GoogleGenAI({ 
      apiKey: geminiKey,
      httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
    });

    const modelsToTry = ["gemini-3.5-flash", "gemini-3.1-flash-lite", "gemini-2.5-flash", "gemini-flash-latest"];
    let lastAnalysisError: any = null;

    for (const modelToUse of modelsToTry) {
      try {
        return await withRetry(async () => {
          const response = await ai.models.generateContent({
            model: modelToUse,
            contents: `Analyze the following HTML article and extract key concepts. Return a JSON object with the following fields:
            - summary: A brief summary of the article.
            - inspiration: The core visual concept derived from the article.
            - prompt: A technical, descriptive image generation prompt in English, focusing on the core concept. Avoid conversational language or introductory phrases.
            - altText: SEO-friendly alt text for the image.
            - caption: A catchy caption for the image.
            - description: A short SEO description.
            - focusKeyword: The main focus keyword.

            HTML Article:
            ${html}`,
            config: {
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  summary: { type: Type.STRING },
                  inspiration: { type: Type.STRING },
                  prompt: { type: Type.STRING },
                  altText: { type: Type.STRING },
                  caption: { type: Type.STRING },
                  description: { type: Type.STRING },
                  focusKeyword: { type: Type.STRING },
                },
                required: ["summary", "inspiration", "prompt", "altText", "caption", "description", "focusKeyword"],
              },
            },
          });

          return JSON.parse(response.text || "{}") as AnalysisResult;
        });
      } catch (err: any) {
        lastAnalysisError = err;
        const errorString = JSON.stringify(err).toLowerCase();
        const isAuthOrModelError = 
          err.status === 403 || err.code === 403 ||
          err.status === 404 || err.code === 404 ||
          errorString.includes('403') || errorString.includes('404') ||
          errorString.includes('permission') || errorString.includes('not found') ||
          errorString.includes('not allowed');

        if (isAuthOrModelError && modelToUse !== modelsToTry[modelsToTry.length - 1]) {
          console.warn(`Modello ${modelToUse} non supportato o accesso negato (403/404). Tento con ${modelsToTry[modelsToTry.indexOf(modelToUse) + 1]}...`);
          continue;
        }
        break; // Altri errori o ultimo modello, esci dal ciclo
      }
    }

    // Se siamo arrivati qui senza ritornare, tutti i tentativi con Gemini hanno fallito.
    // Proviamo il fallback su OpenRouter se configurato:
    if (openrouterApiKey?.trim()) {
      try {
        console.warn("Gemini fallito per l'analisi, provo fallback su OpenRouter...");
        return await analyzeWithOpenRouter(html, openrouterApiKey.trim());
      } catch (orErr) {
        console.error("Anche il fallback su OpenRouter è fallito:", orErr);
      }
    }

    const lastErrorString = JSON.stringify(lastAnalysisError).toLowerCase();
    const isPermissionDenied =
      lastAnalysisError && (
        lastAnalysisError.status === 403 ||
        lastAnalysisError.code === 403 ||
        lastErrorString.includes('403') ||
        lastErrorString.includes('permission_denied') ||
        lastErrorString.includes('not have permission') ||
        lastErrorString.includes('caller does not have permission')
      );

    if (isPermissionDenied) {
      throw new Error(`Errore di autorizzazione (403 PERMISSION_DENIED) dalle API di Google Gemini durante l'analisi del testo: La chiave API inserita non è valida o non ha i permessi necessari per l'analisi del testo. Verifica la configurazione della tua API Key personale.`);
    }

    throw lastAnalysisError || new Error("Errore sconosciuto durante l'analisi dell'articolo con le API Gemini.");
  }

  // Se Gemini non è disponibile per qualche motivo (raro in questo ambiente), usiamo OpenRouter
  if (openrouterApiKey?.trim()) {
    return analyzeWithOpenRouter(html, openrouterApiKey.trim());
  }

  throw new Error("API Key mancante per l'analisi. Inserisci una chiave Gemini o OpenRouter.");
}

async function analyzeWithOpenRouter(html: string, apiKey: string): Promise<AnalysisResult> {
  const prompt = `Analyze the following HTML article and extract key concepts. Return a JSON object with the following fields:
  - summary: A brief summary of the article.
  - inspiration: The core visual concept derived from the article.
  - prompt: A technical, descriptive image generation prompt in English, focusing on the core concept. Avoid conversational language or introductory phrases.
  - altText: SEO-friendly alt text for the image.
  - caption: A catchy caption for the image.
  - description: A short SEO description.
  - focusKeyword: The main focus keyword.

  HTML Article:
  ${html}`;

  return withRetry(async () => {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://cosmonet.ai",
        "X-Title": "Cosmonet Cover Generator"
      },
      body: JSON.stringify({
        model: "google/gemini-2.0-flash-001",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" }
      })
    });

    if (!response.ok) {
      let msg = "";
      try {
        const errorData = await response.json();
        msg = errorData.error?.message || errorData.message || JSON.stringify(errorData);
      } catch {
        msg = `${response.status} ${response.statusText || "Errore Sconosciuto"}`;
      }
      throw new Error(`OpenRouter Analysis Error [${response.status}]: ${msg}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    
    if (!content) throw new Error("Nessun contenuto ricevuto da OpenRouter.");
    
    try {
      return JSON.parse(content) as AnalysisResult;
    } catch (e) {
      throw new Error(`Risposta OpenRouter non valida (JSON atteso): ${content.substring(0, 100)}...`);
    }
  });
}

export async function generateImage(prompt: string, customApiKey?: string, openrouterApiKey?: string): Promise<string> {
  const systemKey = process.env.GEMINI_API_KEY;
  const hasCustomGemini = !!customApiKey?.trim();
  const hasOpenRouter = !!openrouterApiKey?.trim();

  // Se l'utente ha configurato OpenRouter ma NON ha una chiave Gemini personale,
  // preferiamo di gran lunga OpenRouter per le immagini poichè la chiave gratuita di sistema genera 403 per le immagini.
  if (!hasCustomGemini && hasOpenRouter) {
    try {
      return await generateImageWithOpenRouter(prompt, openrouterApiKey!.trim());
    } catch (err) {
      console.warn("OpenRouter Image Error, provo Gemini come backup:", err);
    }
  }

  const geminiKey = (customApiKey || systemKey || "").trim();

  if (geminiKey) {
    try {
      return await generateImageWithGemini(prompt, geminiKey);
    } catch (err: any) {
      // Se Gemini fallisce per qualsiasi motivo (come 403) e abbiamo OpenRouter di fallback, proviamo OpenRouter
      if (hasOpenRouter) {
        console.warn("Gemini Image Error, provo fallback su OpenRouter:", err);
        return await generateImageWithOpenRouter(prompt, openrouterApiKey!.trim());
      }
      throw err;
    }
  }

  if (openrouterApiKey?.trim()) {
    return generateImageWithOpenRouter(prompt, openrouterApiKey.trim());
  }

  throw new Error("API Key mancante per la generazione immagini. Inserisci una chiave Gemini personale o OpenRouter.");
}

export function getRandomCyberpunkFallbackImage(prompt: string): string {
  const images = [
    "https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1545239351-ef35f43d514b?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1509198397868-475647b2a1e5?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1522071820081-009f0129c71c?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1563089145-599997674d42?auto=format&fit=crop&w=1200&q=80",
    "https://images.unsplash.com/photo-1508739773434-c26b3d09e071?auto=format&fit=crop&w=1200&q=80"
  ];
  let hash = 0;
  for (let i = 0; i < prompt.length; i++) {
    hash = prompt.charCodeAt(i) + ((hash << 5) - hash);
  }
  const index = Math.abs(hash) % images.length;
  return images[index];
}

async function generateImageWithGemini(prompt: string, apiKey: string): Promise<string> {
  const ai = new GoogleGenAI({ 
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
  });
  const modelToUse = "gemini-2.5-flash-image";
  const fullPrompt = `${prompt}. ${MANDATORY_STYLE}`;
  
  try {
    return await withRetry(async () => {
      const response = await ai.models.generateContent({
        model: modelToUse,
        contents: {
          parts: [{ text: fullPrompt }],
        },
        config: {
          imageConfig: {
            aspectRatio: "16:9",
          },
        },
      });

      const candidate = response.candidates?.[0];
      
      if (!candidate) {
        throw new Error(`No candidates returned from Gemini API.`);
      }

      if (candidate.finishReason && !['STOP'].includes(candidate.finishReason)) {
        let reasonMsg = `Image generation stopped. Reason: ${candidate.finishReason}`;
        if (candidate.finishMessage) {
          reasonMsg += ` (${candidate.finishMessage})`;
        }
        throw new Error(reasonMsg);
      }

      const parts = candidate.content?.parts || [];
      
      for (const part of parts) {
        if (part.inlineData) {
          return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
        }
      }

      const textPart = parts.find(p => p.text !== undefined && p.text !== null)?.text;
      if (typeof textPart === 'string') {
        if (textPart.trim().length === 0) {
          throw new Error("Model returned an empty text part instead of an image.");
        }
        if (textPart.length < 500) {
          throw new Error(`Model returned a text message instead of an image: "${textPart}"`);
        } else {
          throw new Error("Model returned a long text block instead of an image.");
        }
      }

      throw new Error(`No image data found in response parts.`);
    });
  } catch (err: any) {
    const errorString = JSON.stringify(err).toLowerCase();
    const isPermissionDenied =
      err.status === 403 ||
      err.code === 403 ||
      errorString.includes('403') ||
      errorString.includes('permission_denied') ||
      errorString.includes('not have permission') ||
      errorString.includes('caller does not have permission');

    if (isPermissionDenied) {
      throw new Error("Errore di autorizzazione (403 PERMISSION_DENIED) dalle API di Google Gemini: La chiave API non è valida o non ha i permessi necessari (ad esempio, la generazione di immagini con 'gemini-2.5-flash-image' richiede un piano con fatturazione abilitata in Google AI Studio). Verifica la configurazione della tua API Key personale.");
    }
    throw err;
  }
}

async function generateImageWithOpenRouter(prompt: string, apiKey: string): Promise<string> {
  const fullPrompt = `${prompt}. ${MANDATORY_STYLE}`;
  
  return withRetry(async () => {
    try {
      // Nota: Non tutti i modelli su OpenRouter supportano l'endpoint /images/generations.
      // DALL-E 3 è uno dei pochi che OpenRouter potrebbe passare a OpenAI.
      const response = await fetch("https://openrouter.ai/api/v1/images/generations", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://cosmonet.ai",
          "X-Title": "Cosmonet Cover Generator"
        },
        body: JSON.stringify({
          prompt: fullPrompt,
          model: "openai/dall-e-3",
          response_format: "b64_json"
        })
      });

      if (!response.ok) {
        let msg = "";
        try {
          const errorData = await response.json();
          msg = errorData.error?.message || errorData.message || JSON.stringify(errorData);
        } catch {
          msg = `${response.status} ${response.statusText || "Errore Sconosciuto"}`;
        }
        
        throw new Error(`OpenRouter Image Error [${response.status}]: ${msg}.`);
      }

      const data = await response.json();
      const b64 = data.data?.[0]?.b64_json;
      if (b64) return `data:image/png;base64,${b64}`;
      
      const url = data.data?.[0]?.url;
      if (url) return url;

      throw new Error("OpenRouter non ha restituito dati immagine validi.");
    } catch (err: any) {
      // Se fallisce l'endpoint immagini, spieghiamo chiaramente che potrebbe essere un limite del servizio OpenRouter
      if (err.message?.includes('404') || err.message?.includes('endpoint')) {
        throw new Error("L'endpoint immagini di OpenRouter non sembra supportare questo modello o non è attivo per questa chiave. Ti consigliamo vivamente di inserire una Gemini API Key per le immagini Cyberpunk.");
      }
      throw err;
    }
  });
}

export function analyzeArticleHeuristically(html: string): AnalysisResult {
  let title = "Cyberpunk Neo Article";
  let contentText = "";
  let focusKeyword = "cyberpunk tech";
  
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    
    // Find title
    const titleEl = doc.querySelector("title") || doc.querySelector("h1") || doc.querySelector("h2");
    if (titleEl && titleEl.textContent) {
      title = titleEl.textContent.trim();
    }
    
    // Find focus keyphrase
    // Look first at Yoast comment
    const commentMatch = html.match(/<!--([\s\S]*?)-->/);
    if (commentMatch) {
      const commentBody = commentMatch[1];
      const keyphraseMatch = commentBody.match(/yoast\s+focus\s+keyphrase\s*:\s*(.+)/i);
      if (keyphraseMatch) {
        focusKeyword = keyphraseMatch[1].trim();
      }
    }
    
    // Fallback focus keyword if still default
    if (focusKeyword === "cyberpunk tech" && title !== "Cyberpunk Neo Article") {
      focusKeyword = title.toLowerCase().split(/\s+/).slice(0, 3).join(" ");
    }
    
    // Get text body
    const paragraphs = Array.from(doc.querySelectorAll("p, li, article"));
    contentText = paragraphs
      .map(p => p.textContent || "")
      .filter(t => t.trim().length > 20)
      .join(" ")
      .substring(0, 500);
      
  } catch (e) {
    // Basic regex fallback if DOMParser fails
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i) || html.match(/<h1>([^<]+)<\/h1>/i);
    if (titleMatch) title = titleMatch[1].trim();
    
    // Remove tags
    contentText = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 500);
  }
  
  if (!contentText) {
    contentText = html.trim().substring(0, 500) || "No content text found.";
  }

  const cleanTitle = title.replace(/["'“”]/g, "");
  
  const summary = `Un'analisi approfondita incentrata su '${cleanTitle}'. L'articolo esplora evoluzioni tecnologiche, impatti sul mercato e dinamiche di innovazione nel settore digitale contemporaneo.`;
  const inspiration = `Una metafora visuale futuristica legata a '${cleanTitle}', raffigurante un'interfaccia olografica fluttuante con flussi di dati al neon in uno scenario metropolitano notturno.`;
  
  const cleanKeyword = focusKeyword.replace(/[^a-zA-Z0-9\s]/g, "");
  const prompt = `Futuristic technological interface with glowing data streams, neon colors, representing ${cleanKeyword || cleanTitle}, set in a high contrast cyberpunk cityscape, dramatic perspective, volumetric fog, digital details.`;
  const altText = `Copertina cyberpunk per l'articolo ${cleanTitle} sul tema ${focusKeyword}.`;
  const caption = `${cleanTitle}: l'impatto e il futuro di ${focusKeyword}.`;
  const description = `Scopri tutti i dettagli e le analisi cruciali su ${focusKeyword} nell'articolo di approfondimento dedicato a ${cleanTitle}.`;

  return {
    summary,
    inspiration,
    prompt,
    altText,
    caption,
    description,
    focusKeyword
  };
}

