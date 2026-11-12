import { useEffect, useState } from 'react';
import QRCode from 'qrcode';

/** QR code rendered locally (no network) as a PNG data URL. */
export function Qr({ text, label }: { text: string; label: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 440,
      color: { dark: '#6f0e12', light: '#ffffff' },
    }).then(
      (url) => live && setSrc(url),
      () => live && setSrc(null),
    );
    return () => {
      live = false;
    };
  }, [text]);
  return <div className="qr">{src ? <img src={src} alt={label} /> : null}</div>;
}
