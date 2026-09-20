export type PrivexaMode = 'LATENCY' | 'BALANCED' | 'ACCURACY';

export interface PageAnalysisResult {
  score: number;
  suggestedMode: PrivexaMode;
  reason: string;
  signals: {
    canvasCount: number;
    objectEmbedCount: number;
    isPdf: boolean;
    inputCount: number;
    imageCount: number;
    textNodeRatio: number;
  };
}

/**
 * Runs a fast, client-side heuristic scan to determine the complexity
 * of the page and suggest the optimal Privexa Mode.
 * This should run in under 5ms.
 */
export function analyzePageComplexity(): PageAnalysisResult {
  let score = 0;

  // 1. Canvas Elements (High Signal for visual need)
  const canvasCount = document.querySelectorAll('canvas').length;
  if (canvasCount >= 1 && canvasCount <= 2) score += 2;
  else if (canvasCount > 2) score += 5;

  // 2. Objects / Embeds / iFrames (Often contain opaque visual content)
  const objectEmbedCount = document.querySelectorAll('object, embed, iframe').length;
  if (objectEmbedCount > 0) score += 2;

  // 3. PDF Detection (Critical Signal for visual need)
  const isPdf = 
    document.contentType === 'application/pdf' || 
    window.location.hostname === 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai'; // Chrome PDF Viewer
  
  if (isPdf) score += 10;

  // 4. Form Inputs (Signal that DOM is likely sufficient)
  const inputCount = document.querySelectorAll('input, select, textarea').length;
  if (inputCount > 5) score -= 2; // Heavily form-based pages are great for DOM mode

  // 5. Image to Text Ratio
  const imageCount = document.querySelectorAll('img, picture').length;
  // Quick heuristic for text volume: count paragraphs, headings, and span elements with text
  const textElements = document.querySelectorAll('p, h1, h2, h3, h4, h5, h6, span, label');
  const textNodeRatio = textElements.length > 0 ? imageCount / textElements.length : 0;
  
  if (textNodeRatio > 0.6 && imageCount > 2) score += 3;

  // Determine suggested mode
  let suggestedMode: PrivexaMode;
  let reason: string;

  if (score >= 7) {
    suggestedMode = 'ACCURACY';
    reason = isPdf 
      ? "We detected a PDF. Accuracy Mode ensures full visual reading."
      : "This page is highly visual with many rendered elements. Accuracy Mode is recommended.";
  } else if (score >= 2) {
    suggestedMode = 'BALANCED';
    reason = `We detected ${canvasCount > 0 ? 'canvas elements' : 'complex visual layouts'}. Balanced Mode gives the best coverage safely.`;
  } else {
    suggestedMode = 'LATENCY';
    reason = "This page is built with standard HTML elements. Latency Mode is perfect here.";
  }

  return {
    score,
    suggestedMode,
    reason,
    signals: {
      canvasCount,
      objectEmbedCount,
      isPdf,
      inputCount,
      imageCount,
      textNodeRatio
    }
  };
}
