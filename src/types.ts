export interface AnalysisResult {
  summary: string;
  inspiration: string;
  prompt: string;
  altText: string;
  caption: string;
  description: string;
  focusKeyword: string;
}

export interface GenerationRecord {
  id: string;
  timestamp: number;
  htmlInput: string;
  analysis: AnalysisResult;
  imageUrl: string; // This will be the branded image (base64)
  isFallbackImage?: boolean;
  isFallbackAnalysis?: boolean;
}
