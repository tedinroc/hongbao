/**
 * Share targets for a packet link (SPEC.md, "Phase 2: sharing"), in the order the page
 * shows them: Telegram first (Mezo's community lives there), then WhatsApp and LINE.
 */
export interface ShareUrls {
  telegram: string;
  whatsapp: string;
  line: string;
}

/** `text` is the invitation without the link; each target gets the link the way it expects. */
export function shareUrls(link: string, text: string): ShareUrls {
  const withLink = `${text}\n${link}`;
  return {
    telegram: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(withLink)}`,
    line: `https://line.me/R/share?text=${encodeURIComponent(withLink)}`,
  };
}
