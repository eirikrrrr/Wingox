// The official MikroTik documentation for a section: the exact page and heading
// (src/docsLinks.ts, generated and verified by dev/docs-links.py), or a search
// of the RouterOS docs when a section has no curated link.
import { DOCS } from "./docsLinks";

export function docsLink(sectionId: string, label: string): { url: string; exact: boolean } {
  const url = DOCS[sectionId];
  if (url) return { url, exact: true };
  const q = encodeURIComponent(`RouterOS ${label}`);
  return { url: `https://help.mikrotik.com/docs/dosearchsite.action?where=ROS&queryString=${q}`, exact: false };
}

/** open in the system browser (outside the desktop shell: a new tab) */
export async function openDocs(url: string) {
  try {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  } catch {
    window.open(url, "_blank", "noopener");
  }
}
