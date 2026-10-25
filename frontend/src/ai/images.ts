/**
 * Photos for the AI: a file the user picked, pasted or dropped, shrunk in the
 * browser before it travels to ai-bridge. The model reads at most ~1568 px on
 * the long side, so anything larger is only upload time and tokens; JPEG at
 * that size stays far below the bridge's 5 MB cap.
 */
export interface ChatImage {
  mediaType: 'image/jpeg' | 'image/png';
  /** Base64 without the data: prefix — what the bridge forwards to claude. */
  data: string;
  /** data: URL for the thumbnail. */
  url: string;
}

export const MAX_CHAT_IMAGES = 4;
const MAX_SIDE = 1568;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('unreadable'));
    img.src = url;
  });
}

/**
 * The file as a ChatImage. Rejects with 'not-image' for other files and
 * 'unreadable' for an image the browser cannot decode (HEIC from an iPhone
 * in most browsers).
 */
export async function prepareImage(file: File): Promise<ChatImage> {
  if (!file.type.startsWith('image/')) throw new Error('not-image');
  const src = URL.createObjectURL(file);
  try {
    const img = await loadImage(src);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('unreadable');
    // Transparent PNGs (screenshots, renders) keep a white background in JPEG.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const url = canvas.toDataURL('image/jpeg', 0.85);
    return { mediaType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), url };
  } finally {
    URL.revokeObjectURL(src);
  }
}

/** Image files among a paste or a drop. */
export function imageFiles(list: FileList | DataTransferItemList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  for (const entry of Array.from(list as ArrayLike<File | DataTransferItem>)) {
    const file = entry instanceof File ? entry : entry.kind === 'file' ? entry.getAsFile() : null;
    if (file && file.type.startsWith('image/')) out.push(file);
  }
  return out;
}

/** The message shape the bridge accepts. */
export const toBridgeImages = (images: ChatImage[]) => images.map(({ mediaType, data }) => ({ mediaType, data }));
