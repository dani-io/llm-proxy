/** navigator.clipboard needs a secure context; the panel runs on plain http
 * inside the LAN, so fall back to the old textarea trick. */
export async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  document.body.removeChild(ta)
  if (!ok) throw new Error('Copy failed')
}
