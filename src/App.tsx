import { useState, useEffect, useRef, ChangeEvent, Component, ErrorInfo, ReactNode } from 'react';
import JSZip from 'jszip';
import { get, set, del } from 'idb-keyval';
import { motion, AnimatePresence } from 'motion/react';
import { 
  History, 
  Plus, 
  Trash2, 
  Copy, 
  Check, 
  Sparkles, 
  Image as ImageIcon, 
  Search, 
  ChevronRight,
  Download,
  Key,
  Moon,
  Sun,
  Upload,
  FileText,
  X,
  Loader2,
  LogOut,
  LogIn,
  ArrowLeft
} from 'lucide-react';
import { analyzeArticle, generateImage, getRandomCyberpunkFallbackImage, analyzeArticleHeuristically } from './lib/gemini';
import { applyBranding } from './lib/canvas';
import { GenerationRecord, AnalysisResult } from './types';
import { 
  auth, 
  db, 
  googleProvider, 
  handleFirestoreError, 
  OperationType 
} from './lib/firebase';
import { 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged, 
  User 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  query, 
  where, 
  orderBy, 
  onSnapshot, 
  deleteDoc, 
  doc 
} from 'firebase/firestore';

// ─── ESTRAI FRASE CHIAVE DAL BLOCCO COMMENTO HTML ────────────────────────────
/**
 * Cerca nel blocco commento <!-- ... --> in cima all'HTML la riga
 * "Yoast focus keyphrase: <valore>" e la restituisce.
 * Restituisce null se non trovata.
 */
function extractFocusKeyphrase(html: string): string | null {
  // Cattura il primo blocco commento HTML
  const commentMatch = html.match(/<!--([\s\S]*?)-->/);
  if (!commentMatch) return null;

  const commentBody = commentMatch[1];
  // Cerca la riga con la frase chiave (case-insensitive, con o senza spazi)
  const keyphraseMatch = commentBody.match(
    /yoast\s+focus\s+keyphrase\s*:\s*(.+)/i
  );
  if (!keyphraseMatch) return null;

  return keyphraseMatch[1].trim();
}
// ─────────────────────────────────────────────────────────────────────────────

// Simple Error Boundary Fallback
function ErrorBoundary({ children }: { children: ReactNode }) {
  const [hasError, setHasError] = useState(false);
  const [errorInfo, setErrorInfo] = useState<string | null>(null);

  useEffect(() => {
    const handleError = (event: ErrorEvent) => {
      setHasError(true);
      setErrorInfo(event.error?.message || "Errore sconosciuto");
    };
    window.addEventListener('error', handleError);
    return () => window.removeEventListener('error', handleError);
  }, []);

  if (hasError) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6 bg-brand-bg text-brand-text">
        <div className="glass p-8 rounded-3xl max-w-md w-full text-center space-y-4">
          <h2 className="text-2xl font-bold text-red-500">Ops! Qualcosa è andato storto.</h2>
          <p className="text-brand-muted">Si è verificato un errore imprevisto. Prova a ricaricare la pagina.</p>
          {errorInfo && (
            <pre className="text-xs bg-black/5 p-4 rounded-xl overflow-auto text-left max-h-40">
              {errorInfo}
            </pre>
          )}
          <button 
            onClick={() => window.location.reload()}
            className="btn-primary w-full"
          >
            Ricarica Pagina
          </button>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

export default function AppWrapper() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  );
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [htmlInput, setHtmlInput] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<{ name: string, content: string }[]>([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [batchProgress, setBatchProgress] = useState({ current: 0, total: 0 });
  const [currentResult, setCurrentResult] = useState<GenerationRecord | null>(null);
  const [batchResults, setBatchResults] = useState<GenerationRecord[]>([]);
  const [history, setHistory] = useState<GenerationRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isZipping, setIsZipping] = useState(false);
  const [customApiKey, setCustomApiKey] = useState(() => localStorage.getItem('cosmonet_api_key') || '');
  const [openrouterApiKey, setOpenrouterApiKey] = useState(() => localStorage.getItem('cosmonet_openrouter_key') || '');
  const [showApiKeyInput, setShowApiKeyInput] = useState(false);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    const saved = localStorage.getItem('cosmonet_theme');
    return saved === 'dark' || (!saved && window.matchMedia('(prefers-color-scheme: dark)').matches);
  });

  // Storage key helper
  const getHistoryKey = () => user ? `cosmonet_history_${user.uid}` : 'cosmonet_history_anonymous';

  // Persistence helpers
  const saveHistory = async (data: GenerationRecord[]) => {
    try {
      await set(getHistoryKey(), data);
    } catch (e) {
      console.error("Failed to save to IndexedDB", e);
      setError("Impossibile salvare la cronologia: spazio insufficiente.");
    }
  };

  // Auth Listener
  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // Real-time Firestore synchronization / IndexedDB fallback
  useEffect(() => {
    if (!isAuthReady) return;

    if (user) {
      // Listen to Firestore for current user generations
      const q = query(
        collection(db, 'generations'),
        where('userId', '==', user.uid),
        orderBy('timestamp', 'desc')
      );

      const unsubscribe = onSnapshot(q, (snapshot) => {
        const items: GenerationRecord[] = [];
        snapshot.forEach((doc) => {
          const data = doc.data();
          items.push({
            id: doc.id,
            timestamp: data.timestamp,
            htmlInput: data.htmlInput || '',
            analysis: data.analysis,
            imageUrl: data.imageUrl,
            isFallbackImage: data.isFallbackImage || false,
            isFallbackAnalysis: data.isFallbackAnalysis || false,
          });
        });
        setHistory(items);
      }, (error) => {
        console.error("Firestore onSnapshot error:", error);
        // Fallback to local IDB if offline or permissions temporarily fail
        get(getHistoryKey()).then(saved => {
          if (saved) setHistory(saved);
        });
      });

      return () => unsubscribe();
    } else {
      // Load from local IndexedDB for guest user
      const loadLocal = async () => {
        try {
          const saved = await get('cosmonet_history_anonymous');
          if (saved) {
            setHistory(saved as GenerationRecord[]);
          } else {
            setHistory([]);
          }
        } catch (e) {
          console.error("Failed to load local history from IDB", e);
        }
      };
      loadLocal();
    }
  }, [user, isAuthReady]);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('cosmonet_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('cosmonet_theme', 'light');
    }
  }, [isDarkMode]);

  const login = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      console.error("Login failed", err);
    }
  };

  const logout = async () => {
    try {
      await signOut(auth);
      setCurrentResult(null);
      setBatchResults([]);
    } catch (err) {
      console.error("Logout failed", err);
    }
  };

  const saveToLocalHistory = async (record: GenerationRecord) => {
    if (user) {
      // Save directly to Firestore for logged in users
      try {
        await addDoc(collection(db, 'generations'), {
          id: record.id,
          userId: user.uid,
          timestamp: record.timestamp,
          htmlInput: record.htmlInput || '',
          analysis: record.analysis,
          imageUrl: record.imageUrl,
          isFallbackImage: !!record.isFallbackImage,
          isFallbackAnalysis: !!record.isFallbackAnalysis
        });
      } catch (e) {
        handleFirestoreError(e, OperationType.CREATE, 'generations');
      }
    } else {
      // Save to IndexedDB for guest users
      const updatedHistory = [record, ...history].slice(0, 100);
      setHistory(updatedHistory);
      await saveHistory(updatedHistory);
    }
  };

  const deleteFromHistory = async (id: string) => {
    if (user) {
      // Delete from Firestore
      try {
        await deleteDoc(doc(db, 'generations', id));
      } catch (e) {
        handleFirestoreError(e, OperationType.DELETE, `generations/${id}`);
      }
    } else {
      // Delete from local
      const updatedHistory = history.filter(h => h.id !== id);
      setHistory(updatedHistory);
      await saveHistory(updatedHistory);
    }
    if (currentResult?.id === id) {
      setCurrentResult(null);
    }
  };

  const handleFileChange = async (e: ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    
    const newFiles: { name: string, content: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type === 'text/html' || file.name.endsWith('.html') || file.name.endsWith('.htm')) {
        const content = await file.text();
        newFiles.push({ name: file.name, content });
      }
    }
    setUploadedFiles(prev => [...prev, ...newFiles]);
  };

  const removeFile = (index: number) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  const processItem = async (content: string, name: string): Promise<GenerationRecord> => {
    let analysis: AnalysisResult;
    let isFallbackAnalysis = false;
    try {
      analysis = await analyzeArticle(content, customApiKey, openrouterApiKey);
    } catch (err: any) {
      console.warn("Analisi API fallita, provo l'analisi euristica locale:", err);
      isFallbackAnalysis = true;
      analysis = analyzeArticleHeuristically(content);
    }
    
    // Additional delay between analysis and image generation to space out requests
    await new Promise(resolve => setTimeout(resolve, 2000));

    // ── OVERRIDE: usa la frase chiave dal blocco commento dell'HTML ──────────
    const keyphraseFromHtml = extractFocusKeyphrase(content);
    if (keyphraseFromHtml) {
      analysis.focusKeyword = keyphraseFromHtml;
    }
    // ─────────────────────────────────────────────────────────────────────────

    let rawImage = "";
    let isFallbackImage = false;
    try {
      rawImage = await generateImage(analysis.prompt, customApiKey, openrouterApiKey);
    } catch (imageErr: any) {
      console.warn("Generazione immagine con API fallita, provo con l'immagine di backup:", imageErr);
      isFallbackImage = true;
      rawImage = getRandomCyberpunkFallbackImage(analysis.prompt);
    }
    const brandedImage = await applyBranding(rawImage);

    return {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: Date.now(),
      htmlInput: content,
      analysis,
      imageUrl: brandedImage,
      isFallbackImage,
      isFallbackAnalysis
    };
  };

  const handleGenerate = async () => {
    const hasInput = htmlInput.trim().length > 0;
    const hasFiles = uploadedFiles.length > 0;
    
    if (!hasInput && !hasFiles) return;
    
    setIsAnalyzing(true);
    setError(null);
    setCurrentResult(null);
    setBatchResults([]);

    try {
      const itemsToProcess: { content: string, name: string }[] = [];
      
      if (hasInput) {
        itemsToProcess.push({ content: htmlInput, name: 'Testo incollato' });
      }
      
      uploadedFiles.forEach(f => itemsToProcess.push(f));
      
      setBatchProgress({ current: 0, total: itemsToProcess.length });
      
      const results: GenerationRecord[] = [];
      
      for (let i = 0; i < itemsToProcess.length; i++) {
        setBatchProgress(prev => ({ ...prev, current: i + 1 }));
        const item = itemsToProcess[i];
        const record = await processItem(item.content, item.name);
        results.push(record);
        await saveToLocalHistory(record);
        
        if (i < itemsToProcess.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 6000));
        }
      }

      if (results.length === 1) {
        setCurrentResult(results[0]);
      } else {
        setBatchResults(results);
      }
      
      setHtmlInput('');
      setUploadedFiles([]);
    } catch (err: any) {
      console.error(err);
      if (err.message?.includes('429') || JSON.stringify(err).includes('quota') || JSON.stringify(err).includes('RESOURCE_EXHAUSTED')) {
        setError("Quota API Gemini temporaneamente esaurita per il tuo piano. Attendi qualche minuto o prova a elaborare meno file alla volta.");
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setError(errorMsg);
      }
    } finally {
      setIsAnalyzing(false);
      setBatchProgress({ current: 0, total: 0 });
    }
  };

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  // ─── GENERA CSV (helper puro) ─────────────────────────────────────────────
  const buildCSVBlob = (records: GenerationRecord[]): Blob => {
    const header = 'filename,alt_text,caption,description';
    const rows = records.map(r => {
      const filename = `${r.analysis.focusKeyword.toLowerCase().replace(/\s+/g, '-')}.webp`;
      const escape = (s: string) => `"${s.replace(/"/g, '""')}"`;
      return [
        filename,
        escape(r.analysis.altText),
        escape(r.analysis.caption),
        escape(r.analysis.description)
      ].join(',');
    });
    return new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
  };
  // ─────────────────────────────────────────────────────────────────────────────

  // ─── DOWNLOAD COMBINATO IN UN UNICO FILE ZIP ─────────────────────────────────
  /**
   * Crea un unico file ZIP contenente i metadati (media-meta.csv) e tutte le immagini generate.
   * Funziona sia per risultati multipli (batch) sia per singoli risultati.
   */
  const downloadAll = async (records: GenerationRecord[]) => {
    if (records.length === 0) return;
    setIsZipping(true);
    try {
      const zip = new JSZip();

      // ── 1. Aggiunge il file CSV con i metadati nel ZIP ─────────────────────
      const csvBlob = buildCSVBlob(records);
      zip.file('media-meta.csv', csvBlob);

      // ── 2. Aggiunge le immagini (.webp) nel ZIP ──────────────────────────────
      await Promise.all(
        records.map(async (r) => {
          const filename = `${r.analysis.focusKeyword.toLowerCase().replace(/\s+/g, '-')}.webp`;
          
          let blob: Blob;
          if (r.imageUrl.startsWith('data:')) {
            // Convert byte data URL directly to blob to avoid fetch issues in iframe sandboxes
            const parts = r.imageUrl.split(',');
            const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/webp';
            const bstr = atob(parts[1]);
            let n = bstr.length;
            const u8arr = new Uint8Array(n);
            while (n--) {
              u8arr[n] = bstr.charCodeAt(n);
            }
            blob = new Blob([u8arr], { type: mime });
          } else {
            const res = await fetch(r.imageUrl);
            blob = await res.blob();
          }
          zip.file(filename, blob);
        })
      );

      // ── 3. Genera il file ZIP unico e avvia il download ──────────────────────
      const zipContent = await zip.generateAsync({ type: 'blob' });
      const zipUrl = URL.createObjectURL(zipContent);
      const zipLink = document.createElement('a');
      zipLink.href = zipUrl;

      // Nome dinamico basato sul contenuto
      let zipName = 'cosmonet-export.zip';
      if (records.length === 1) {
        const keywordFilename = records[0].analysis.focusKeyword.toLowerCase().replace(/\s+/g, '-');
        zipName = `${keywordFilename}.zip`;
      }

      zipLink.download = zipName;
      document.body.appendChild(zipLink);
      zipLink.click();
      document.body.removeChild(zipLink);
      URL.revokeObjectURL(zipUrl);
    } catch (err) {
      console.error('Download error:', err);
    } finally {
      setIsZipping(false);
    }
  };

  const downloadSingleImage = (record: GenerationRecord) => {
    try {
      const filename = `${record.analysis.focusKeyword.toLowerCase().replace(/\s+/g, '-')}.webp`;
      const link = document.createElement('a');
      link.href = record.imageUrl;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err) {
      console.error("Failed to download image", err);
      setError("Errore nel download diretto dell'immagine. Prova ad usare l'esportazione ZIP.");
    }
  };

  const downloadSingleCSV = (record: GenerationRecord) => {
    const csvBlob = buildCSVBlob([record]);
    const url = URL.createObjectURL(csvBlob);
    const link = document.createElement('a');
    link.href = url;
    const keywordFilename = record.analysis.focusKeyword.toLowerCase().replace(/\s+/g, '-');
    link.download = `${keywordFilename}-meta.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const downloadBatchCSV = (records: GenerationRecord[]) => {
    const csvBlob = buildCSVBlob(records);
    const url = URL.createObjectURL(csvBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'media-meta.csv';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };
  // ─────────────────────────────────────────────────────────────────────────────

  const openProKey = async () => {
    setShowApiKeyInput(!showApiKeyInput);
  };

  const handleApiKeyChange = (val: string) => {
    setCustomApiKey(val);
    localStorage.setItem('cosmonet_api_key', val);
  };

  const handleOpenRouterKeyChange = (val: string) => {
    setOpenrouterApiKey(val);
    localStorage.setItem('cosmonet_openrouter_key', val);
  };

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="sticky top-0 z-50 glass border-b border-brand-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00d2ff] to-[#9d50bb]" />
          <h1 className="text-xl font-bold tracking-tight">COSMONET</h1>
        </div>
        
        <div className="flex items-center gap-3">
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="btn-secondary p-2.5 flex items-center justify-center"
            title={isDarkMode ? "Passa a modalità chiara" : "Passa a modalità scura"}
          >
            {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          
          {user ? (
            <div className="flex items-center gap-3">
              <button 
                onClick={logout}
                className="btn-secondary flex items-center gap-2 text-sm py-2 px-4 text-red-500 hover:bg-red-50"
              >
                <LogOut size={16} />
                <span>Esci</span>
              </button>
              <button 
                onClick={() => setShowHistory(!showHistory)}
                className="btn-secondary flex items-center gap-2 text-sm py-2 px-4"
              >
                <History size={16} />
                <span>Cronologia</span>
              </button>
            </div>
          ) : (
            <button 
              onClick={login}
              className="btn-primary flex items-center gap-2 text-sm py-2 px-4"
            >
              <LogIn size={16} />
              <span>Accedi</span>
            </button>
          )}

          <button 
            onClick={openProKey}
            className={`btn-secondary flex items-center gap-2 text-sm py-2 px-4 ${(customApiKey || openrouterApiKey) ? 'text-green-500 border-green-500/30' : ''}`}
          >
            <Key size={16} />
            <span>{(customApiKey || openrouterApiKey) ? 'IA Pronta' : 'Configura IA'}</span>
          </button>
        </div>
      </header>

      {/* API Key Modal/Input Overlay */}
      <AnimatePresence>
        {showApiKeyInput && (
          <motion.div 
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="fixed inset-0 z-[100] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm"
          >
            <div className="glass w-full max-w-md p-8 rounded-[2rem] shadow-2xl relative">
              <button 
                onClick={() => setShowApiKeyInput(false)}
                className="absolute top-4 right-4 text-brand-muted hover:text-brand-text"
              >
                <X size={20} />
              </button>
              
              <div className="space-y-6">
                <div className="text-center">
                  <h3 className="text-2xl font-bold">Configura IA</h3>
                  <p className="text-brand-muted mt-2">
                    Inserisci le chiavi API per utilizzare i servizi.
                  </p>
                </div>
                
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium ml-1 flex items-center gap-2">
                      <img src="https://www.google.com/s2/favicons?domain=google.com" className="w-4 h-4" alt="" />
                      Google Gemini API Key
                    </label>
                    <input 
                      type="password"
                      value={customApiKey}
                      onChange={(e) => handleApiKeyChange(e.target.value)}
                      placeholder="Automatico (Gratuito) ..."
                      className="w-full bg-brand-border/30 border border-brand-border rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-text/20 outline-none transition-all font-mono text-sm"
                    />
                    <p className="text-[10px] text-brand-muted ml-1">
                      Lascia vuoto per usare la <b>chiave gratuita integrata</b> di Cosmonet. Inserisci la tua chiave per limiti più alti. <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noreferrer" className="underline">Ottieni qui</a>
                    </p>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium ml-1 flex items-center gap-2">
                      <img src="https://openrouter.ai/favicon.ico" className="w-4 h-4" alt="" />
                      OpenRouter API Key (Opzionale)
                    </label>
                    <input 
                      type="password"
                      value={openrouterApiKey}
                      onChange={(e) => handleOpenRouterKeyChange(e.target.value)}
                      placeholder="sk-or-v1-..."
                      className="w-full bg-brand-border/30 border border-brand-border rounded-xl px-4 py-3 focus:ring-2 focus:ring-brand-text/20 outline-none transition-all font-mono text-sm"
                    />
                    <p className="text-[10px] text-brand-muted ml-1">
                      Scelta alternativa per l'analisi testi se Gemini è lento. <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer" className="underline">Ottieni qui</a>
                    </p>
                  </div>
                </div>
                
                <div className="pt-2">
                  <button 
                    onClick={() => setShowApiKeyInput(false)}
                    className="btn-primary w-full py-3"
                  >
                    Salva e Chiudi
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <main className="flex-1 max-w-5xl mx-auto w-full p-6 md:p-12 relative">
        <AnimatePresence mode="wait">
          {!currentResult && batchResults.length === 0 && !isAnalyzing ? (
            <motion.div 
              key="input"
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -20 }}
              className="space-y-8"
            >
              <div className="text-center space-y-4">
                <h2 className="text-4xl md:text-5xl font-bold tracking-tight">Crea copertine intelligenti.</h2>
                <p className="text-brand-muted text-lg max-w-2xl mx-auto">
                  Incolla l'HTML o carica i tuoi file. La nostra IA analizzerà i concetti chiave e genererà immagini di copertina brandizzate e ottimizzate per la SEO.
                </p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="glass rounded-3xl p-6 shadow-xl shadow-black/5 space-y-4 flex flex-col">
                  <h3 className="text-lg font-bold flex items-center gap-2">
                    <FileText size={20} />
                    Incolla HTML
                  </h3>
                  <textarea 
                    value={htmlInput}
                    onChange={(e) => setHtmlInput(e.target.value)}
                    placeholder="Incolla qui il codice HTML dell'articolo..."
                    className="flex-1 w-full min-h-[200px] bg-transparent border-none focus:ring-0 resize-none text-lg placeholder:text-brand-muted/50"
                  />
                </div>

                <div className="glass rounded-3xl p-6 shadow-xl shadow-black/5 space-y-4 flex flex-col">
                  <h3 className="text-lg font-bold flex items-center gap-2">
                    <Upload size={20} />
                    Carica File HTML
                  </h3>
                  
                  <div className="flex-1 flex flex-col">
                    <label className="flex-1 border-2 border-dashed border-brand-border rounded-2xl flex flex-col items-center justify-center p-8 cursor-pointer hover:bg-brand-border/30 transition-colors group">
                      <input 
                        type="file" 
                        multiple 
                        accept=".html,.htm" 
                        onChange={handleFileChange}
                        className="hidden"
                      />
                      <Upload size={32} className="text-brand-muted group-hover:text-brand-text transition-colors mb-2" />
                      <p className="text-sm font-medium">Clicca o trascina i file qui</p>
                      <p className="text-xs text-brand-muted mt-1">Supporta più file .html</p>
                    </label>

                    {uploadedFiles.length > 0 && (
                      <div className="mt-4 space-y-2 max-h-40 overflow-y-auto pr-2">
                        {uploadedFiles.map((file, idx) => (
                          <div key={idx} className="flex items-center justify-between bg-brand-border/50 p-2 rounded-lg text-sm">
                            <span className="truncate flex-1 mr-2">{file.name}</span>
                            <button onClick={() => removeFile(idx)} className="text-brand-muted hover:text-red-500">
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="flex justify-center">
                <button 
                  onClick={handleGenerate}
                  disabled={(!htmlInput.trim() && uploadedFiles.length === 0) || isAnalyzing}
                  className="btn-primary flex items-center gap-2 text-lg px-12 py-4"
                >
                  <Sparkles size={24} />
                  Genera {uploadedFiles.length > 1 ? `${uploadedFiles.length + (htmlInput.trim() ? 1 : 0)} Immagini` : 'Immagine'}
                </button>
              </div>
              
              {error && (
                <p className="text-red-500 text-center font-medium">{error}</p>
              )}
            </motion.div>

          ) : isAnalyzing ? (
            <motion.div 
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex flex-col items-center justify-center py-24 space-y-8"
            >
              <div className="relative">
                <div className="w-24 h-24 border-4 border-brand-border rounded-full" />
                <div className="absolute inset-0 w-24 h-24 border-4 border-brand-text border-t-transparent rounded-full animate-spin" />
                {batchProgress.total > 1 && (
                  <div className="absolute inset-0 flex items-center justify-center font-bold text-sm">
                    {batchProgress.current}/{batchProgress.total}
                  </div>
                )}
              </div>
              <div className="text-center space-y-3">
                <h3 className="text-3xl font-bold">
                  {batchProgress.total > 1 ? `Elaborazione ${batchProgress.current} di ${batchProgress.total}` : 'Analisi in corso...'}
                </h3>
                <p className="text-brand-muted text-lg">
                  {batchProgress.total > 1 
                    ? 'Stiamo processando i tuoi file uno alla volta.' 
                    : 'Stiamo estraendo i concetti e preparando il design.'}
                </p>
              </div>
            </motion.div>

          ) : batchResults.length > 0 ? (
            <motion.div 
              key="batch-results"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-12"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-3xl font-bold">Risultati Batch ({batchResults.length})</h2>
                <div className="flex gap-2">
                  <button 
                    onClick={() => downloadBatchCSV(batchResults)}
                    className="btn-secondary py-2 px-4 text-sm flex items-center gap-2"
                  >
                    <FileText size={16} />
                    Scarica solo CSV
                  </button>
                  {/* ── DOWNLOAD TUTTO (ZIP UNICO CON CSV) ── */}
                  <button
                    onClick={() => downloadAll(batchResults)}
                    disabled={isZipping}
                     className="btn-primary py-2 px-5 text-sm flex items-center gap-2 disabled:opacity-50"
                  >
                    {isZipping
                      ? <Loader2 size={16} className="animate-spin" />
                      : <Download size={16} />
                    }
                    {isZipping ? 'Preparazione...' : `Scarica tutto (ZIP con CSV)`}
                  </button>
                  <button 
                    onClick={() => { setBatchResults([]); setCurrentResult(null); }}
                    className="btn-secondary py-2 px-4 text-sm flex items-center gap-2"
                  >
                    <Plus size={16} />
                    Nuova Generazione
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {batchResults.map((result) => (
                  <div 
                    key={result.id} 
                    className="glass rounded-3xl overflow-hidden shadow-xl hover:shadow-2xl transition-all cursor-pointer group flex flex-col"
                    onClick={() => {
                      setCurrentResult(result);
                      setBatchResults([]);
                    }}
                  >
                    <div className="aspect-video bg-brand-border relative overflow-hidden">
                      <img src={result.imageUrl} alt={result.analysis.altText} className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500" />
                      <div className="absolute top-3 left-3 flex flex-col gap-1.5 z-10">
                        {result.isFallbackAnalysis && (
                          <div className="bg-amber-500 text-black text-[9px] font-bold px-2 py-0.5 rounded shadow z-10 flex items-center gap-1 border border-amber-600 w-fit leading-none">
                            <Sparkles size={10} /> ANALISI EURISTICA (403)
                          </div>
                        )}
                        {result.isFallbackImage && (
                          <div className="bg-amber-500 text-black text-[9px] font-bold px-2 py-0.5 rounded shadow z-10 flex items-center gap-1 border border-amber-600 w-fit leading-none">
                            <Sparkles size={10} /> COPERTINA DI FALLBACK
                          </div>
                        )}
                      </div>
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                        <span className="text-white font-bold flex items-center gap-2">
                          Vedi Dettagli <ChevronRight size={20} />
                        </span>
                      </div>
                    </div>
                    <div className="p-6 flex-1 flex flex-col justify-between space-y-4">
                      <div className="space-y-1">
                        <p className="font-bold text-lg truncate">{result.analysis.caption}</p>
                        <p className="text-sm text-brand-muted truncate">Frase chiave: {result.analysis.focusKeyword}</p>
                      </div>

                      <div className="flex items-center gap-2 pt-3 border-t border-brand-border">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadSingleImage(result);
                          }}
                          className="flex-1 bg-brand-border/40 hover:bg-brand-border/80 text-brand-text text-xs py-2 px-3 rounded-xl transition-all flex items-center justify-center gap-1.5 font-medium"
                          title="Scarica solo l'immagine WEBP"
                        >
                          <ImageIcon size={14} />
                          Scarica Immagine
                        </button>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadSingleCSV(result);
                          }}
                          className="bg-brand-border/40 hover:bg-brand-border/80 text-brand-text text-xs p-2 rounded-xl transition-all"
                          title="Scarica solo il file CSV"
                        >
                          <FileText size={14} />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </motion.div>

          ) : (
            <motion.div 
              key="result"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              className="space-y-12"
            >
              <div className="flex items-center justify-between">
                <div className="flex gap-3">
                  <button 
                    onClick={() => {
                      if (batchResults.length > 0) {
                        setCurrentResult(null);
                      } else {
                        setCurrentResult(null);
                        setBatchResults([]);
                      }
                    }}
                    className="btn-secondary py-2 px-4 text-sm flex items-center gap-2"
                  >
                    <ArrowLeft size={16} />
                    {batchResults.length > 0 ? 'Torna ai Risultati' : 'Nuova Generazione'}
                  </button>
                  {batchResults.length === 0 && (
                    <button 
                      onClick={() => { setCurrentResult(null); setBatchResults([]); }}
                      className="btn-secondary py-2 px-4 text-sm flex items-center gap-2"
                    >
                      <Plus size={16} />
                      Nuova
                    </button>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => currentResult && downloadSingleImage(currentResult)}
                    className="btn-secondary py-2 px-4 text-sm flex items-center gap-2 font-medium"
                    title="Scarica solo la copertina in formato WEBP"
                  >
                    <ImageIcon size={16} />
                    Scarica Immagine (.webp)
                  </button>
                  <button
                    onClick={() => currentResult && downloadSingleCSV(currentResult)}
                    className="btn-secondary py-2 px-4 text-sm flex items-center gap-2 font-medium"
                    title="Scarica solo i metadati SEO in formato CSV"
                  >
                    <FileText size={16} />
                    Scarica CSV (.csv)
                  </button>
                  {/* ── DOWNLOAD TUTTO (ZIP UNICO CON CSV + IMMAGINE) ── */}
                  <button
                    onClick={() => currentResult && downloadAll([currentResult])}
                    disabled={isZipping}
                    className="btn-primary py-2 px-5 text-sm flex items-center gap-2 disabled:opacity-50"
                  >
                    {isZipping
                      ? <Loader2 size={16} className="animate-spin" />
                      : <Download size={16} />
                    }
                    {isZipping ? 'Preparazione...' : 'Scarica tutto in ZIP'}
                  </button>
                </div>
              </div>

              <div className="space-y-8">
                <div className="rounded-3xl overflow-hidden shadow-2xl shadow-black/10 aspect-video bg-brand-border relative">
                  <img 
                    src={currentResult?.imageUrl} 
                    alt={currentResult?.analysis.altText}
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-4 left-4 flex flex-col gap-2 z-10">
                    {currentResult?.isFallbackAnalysis && (
                      <div className="bg-amber-500 text-black text-[11px] font-bold px-3 py-1.5 rounded-lg shadow-lg flex items-center gap-1.5 border border-amber-600 w-fit">
                        <Sparkles size={12} /> ANALISI LOCALE ATTIVA (ERRORE 403 API KEY)
                      </div>
                    )}
                    {currentResult?.isFallbackImage && (
                      <div className="bg-amber-500 text-black text-[11px] font-bold px-3 py-1.5 rounded-lg shadow-lg flex items-center gap-1.5 border border-amber-600 w-fit">
                        <Sparkles size={12} /> COPERTINA DI FALLBACK (ERRORE 403 API KEY)
                      </div>
                    )}
                  </div>
                </div>

                {currentResult?.isFallbackAnalysis && (
                  <div className="bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-2xl p-4 text-xs leading-relaxed flex items-start gap-2.5 shadow-sm">
                    <Sparkles className="shrink-0 mt-0.5 text-amber-500" size={16} />
                    <div>
                      <span className="font-semibold block mb-0.5 text-amber-500">Analisi Testuale Euristica Locale Attivata:</span>
                      La tua chiave API Gemini integrata o personale non è valida o non possiede i permessi necessari (Errore 403 Permission Denied) per effettuare l'analisi testuale. Cosmonet ha attivato in automatico l'algoritmo di estrazione locale intelligente per ricavare metadati, parole chiave e prompt dal codice HTML dell'articolo, proteggendo il tuo flusso di lavoro.
                    </div>
                  </div>
                )}

                {currentResult?.isFallbackImage && (
                  <div className="bg-amber-500/10 border border-amber-500/20 text-amber-500 rounded-2xl p-4 text-xs leading-relaxed flex items-start gap-2.5 shadow-sm">
                    <Sparkles className="shrink-0 mt-0.5 text-amber-500" size={16} />
                    <div>
                      <span className="font-semibold block mb-0.5 text-amber-500">Copertina Cyberpunk Standard Applicata:</span>
                      La tua chiave API Gemini integrata o personale non ha l'abilitazione della fatturazione (Paid billing tier in Google AI Studio) richiesta per generare immagini tramite l'API 'gemini-2.5-flash-image' (Errore 403 Permission Denied). Nessun problema! Abbiamo recuperato in automatico una spettacolare fotografia cyberpunk royalty-free ad alta definizione applicando il watermark ufficiale di Cosmonet sul file.
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="space-y-6">
                    <MetadataCard 
                      title="Alt Text" 
                      content={currentResult?.analysis.altText || ''} 
                      onCopy={() => copyToClipboard(currentResult?.analysis.altText || '', 'alt')}
                      isCopied={copiedField === 'alt'}
                    />
                    <MetadataCard 
                      title="Didascalia" 
                      content={currentResult?.analysis.caption || ''} 
                      onCopy={() => copyToClipboard(currentResult?.analysis.caption || '', 'caption')}
                      isCopied={copiedField === 'caption'}
                    />
                  </div>
                  <div className="space-y-6">
                    <MetadataCard 
                      title="Descrizione SEO" 
                      content={currentResult?.analysis.description || ''} 
                      onCopy={() => copyToClipboard(currentResult?.analysis.description || '', 'desc')}
                      isCopied={copiedField === 'desc'}
                    />
                    <MetadataCard 
                      title="Frase Chiave" 
                      content={currentResult?.analysis.focusKeyword || ''} 
                      onCopy={() => copyToClipboard(currentResult?.analysis.focusKeyword || '', 'keyword')}
                      isCopied={copiedField === 'keyword'}
                    />
                  </div>
                </div>

                <div className="glass rounded-3xl p-8 space-y-4">
                  <h3 className="text-xl font-bold flex items-center gap-2">
                    <Search size={20} />
                    Analisi del Concetto
                  </h3>
                  <div className="space-y-4 text-brand-muted leading-relaxed">
                    <p><span className="font-bold text-brand-text">Sintesi:</span> {currentResult?.analysis.summary}</p>
                    <p><span className="font-bold text-brand-text">Ispirazione:</span> {currentResult?.analysis.inspiration}</p>
                  </div>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* History Sidebar */}
      <AnimatePresence>
        {showHistory && (
          <>
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowHistory(false)}
              className="fixed inset-0 bg-black/20 backdrop-blur-sm z-[60]"
            />
            <motion.div 
              initial={{ x: '100%' }}
              animate={{ x: 0 }}
              exit={{ x: '100%' }}
              transition={{ type: 'spring', damping: 25, stiffness: 200 }}
              className="fixed right-0 top-0 bottom-0 w-full max-w-md bg-brand-card z-[70] shadow-2xl flex flex-col"
            >
              <div className="p-6 border-b border-brand-border flex items-center justify-between">
                <h3 className="text-xl font-bold">Cronologia</h3>
                <button 
                  onClick={() => setShowHistory(false)}
                  className="p-2 hover:bg-brand-border rounded-full transition-colors"
                >
                  <ChevronRight size={24} />
                </button>
              </div>
              
              <div className="flex-1 overflow-y-auto p-6 space-y-4">
                {history.length === 0 ? (
                  <div className="text-center py-12 text-brand-muted">
                    <History size={48} className="mx-auto mb-4 opacity-20" />
                    <p>Nessuna generazione salvata.</p>
                  </div>
                ) : (
                  history.map((item) => (
                    <div 
                      key={item.id}
                      className="group glass rounded-2xl p-4 flex gap-4 items-center hover:border-brand-text/20 transition-all cursor-pointer"
                      onClick={() => {
                        setCurrentResult(item);
                        setShowHistory(false);
                      }}
                    >
                      <div className="w-20 h-20 rounded-lg overflow-hidden flex-shrink-0 bg-brand-border">
                        <img src={item.imageUrl} alt="" className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-bold truncate">{item.analysis.caption}</p>
                        <p className="text-xs text-brand-muted">{new Date(item.timestamp).toLocaleString()}</p>
                      </div>
                      <button 
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteFromHistory((item as any).docId || item.id);
                        }}
                        className="p-2 text-brand-muted hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={18} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}

function MetadataCard({ title, content, onCopy, isCopied }: { title: string, content: string, onCopy: () => void, isCopied: boolean }) {
  return (
    <div className="glass rounded-2xl p-5 space-y-3 group">
      <div className="flex items-center justify-between">
        <span className="text-xs font-bold uppercase tracking-wider text-brand-muted">{title}</span>
        <button 
          onClick={onCopy}
          className={`p-2 rounded-lg transition-all ${isCopied ? 'bg-green-500/10 text-green-500' : 'hover:bg-brand-border text-brand-muted group-hover:text-brand-text'}`}
        >
          {isCopied ? <Check size={16} /> : <Copy size={16} />}
        </button>
      </div>
      <p className="text-sm font-medium leading-relaxed">{content}</p>
    </div>
  );
}

declare global {
  interface Window {
    aistudio?: {
      openSelectKey: () => Promise<void>;
      hasSelectedApiKey: () => Promise<boolean>;
    };
  }
}