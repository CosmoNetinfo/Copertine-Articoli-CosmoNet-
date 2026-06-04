import logoUrl from '../logo htlm.png';

export async function applyBranding(base64Image: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const logo = new Image();
    
    img.crossOrigin = 'anonymous';
    
    let imagesLoaded = 0;
    let logoFailed = false;

    const checkLoaded = () => {
      imagesLoaded++;
      if (imagesLoaded === 2) {
        render();
      }
    };

    img.onload = checkLoaded;
    logo.onload = checkLoaded;
    img.onerror = (e) => reject(new Error("Failed to load image: " + e));
    logo.onerror = () => {
      logoFailed = true;
      checkLoaded();
    };

    img.src = base64Image;
    logo.src = logoUrl;

    function render() {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error("Could not get canvas context"));
        return;
      }

      // Draw original image
      ctx.drawImage(img, 0, 0);

      // Save context state for absolute coordinate rendering
      ctx.save();

      // Branding settings
      const padding = canvas.width * 0.03;
      const logoHeight = canvas.height * 0.12;

      // Drop shadow for branding visibility
      ctx.shadowColor = 'rgba(0, 0, 0, 0.7)';
      ctx.shadowBlur = 15;
      ctx.shadowOffsetX = 0;
      ctx.shadowOffsetY = 4;

      if (logoFailed || !logo.width || !logo.height) {
        // Draw a beautiful glowing cyberpunk watermark badge instead of crashing
        const badgeWidth = canvas.width * 0.22;
        const badgeHeight = logoHeight;
        const x = padding;
        const y = canvas.height - padding - badgeHeight;

        // Draw translucent container backing in glassmorphism style
        ctx.fillStyle = 'rgba(10, 10, 10, 0.75)';
        ctx.lineJoin = 'round';
        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0, 210, 255, 0.5)';
        
        // Draw rounded rectangle backing
        ctx.beginPath();
        const radius = 8;
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + badgeWidth - radius, y);
        ctx.quadraticCurveTo(x + badgeWidth, y, x + badgeWidth, y + radius);
        ctx.lineTo(x + badgeWidth, y + badgeHeight - radius);
        ctx.quadraticCurveTo(x + badgeWidth, y + badgeHeight, x + badgeWidth - radius, y + badgeHeight);
        ctx.lineTo(x + radius, y + badgeHeight);
        ctx.quadraticCurveTo(x, y + badgeHeight, x, y + badgeHeight - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();

        // Draw neon accent sphere/logo representation
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#00d2ff';
        ctx.fillStyle = '#00d2ff';
        ctx.beginPath();
        ctx.arc(x + badgeHeight * 0.4, y + badgeHeight * 0.5, badgeHeight * 0.18, 0, Math.PI * 2);
        ctx.fill();

        // Highlight
        ctx.fillStyle = '#9d50bb';
        ctx.shadowColor = '#9d50bb';
        ctx.beginPath();
        ctx.arc(x + badgeHeight * 0.4, y + badgeHeight * 0.5, badgeHeight * 0.08, 0, Math.PI * 2);
        ctx.fill();

        // Draw Text "COSMONET"
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.fillStyle = '#FFFFFF';
        // Size proportional to image dimensions
        const fontSize = Math.max(14, Math.round(badgeHeight * 0.35));
        ctx.font = `bold ${fontSize}px "Inter", sans-serif`;
        ctx.textBaseline = 'middle';
        ctx.fillText("COSMONET", x + badgeHeight * 0.75, y + badgeHeight * 0.5);
      } else {
        const logoAspectRatio = logo.width / logo.height;
        const logoWidth = logoHeight * logoAspectRatio;
        const x = padding;
        const y = canvas.height - padding - logoHeight;

        // Draw the uploaded logo
        ctx.drawImage(logo, x, y, logoWidth, logoHeight);
      }

      ctx.restore();
      resolve(canvas.toDataURL('image/webp'));
    }
  });
}
