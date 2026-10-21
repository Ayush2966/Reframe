import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Copy, X } from 'lucide-react'
import QRCode from 'qrcode'
import { api } from '../api'

/** How to open Reframe on a phone: Tailscale gives the Mac a private HTTPS
 * address that only your own devices can reach. */
export function PhoneDialog({ onClose }: { onClose: () => void }) {
  const status = useQuery({
    queryKey: ['phone'],
    queryFn: api.phone,
    refetchInterval: (q) => (q.state.data?.serving ? false : 3000),
  })
  const [qr, setQr] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const s = status.data
  const url = s?.serving ? s.url : undefined

  useEffect(() => {
    if (!url) return
    QRCode.toDataURL(url, { margin: 1, width: 440, color: { dark: '#1d1e20', light: '#ecece8' } }).then(setQr)
  }, [url])

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
  }, [onClose])

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <>
      <div className="scrim" style={{ zIndex: 30 }} onClick={onClose} />
      <div className="sheet" role="dialog" aria-label="Use Reframe on your phone">
        <header>
          <h2>Use Reframe on your phone</h2>
          <button className="btn quiet icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </header>
        <div className="sheet-body">
          {!s ? (
            <p className="muted">Checking Tailscale…</p>
          ) : url ? (
            <div className="phone-ready">
              {qr && <img src={qr} width={220} height={220} alt={`QR code for ${url}`} />}
              <div className="steps">
                <p>Scan this with your phone's camera. Tailscale needs to be on, on the phone.</p>
                <button className="url num" onClick={() => copy(url)} title="Copy the address">
                  {url} <Copy size={14} />
                </button>
                {copied && <span className="muted">Copied</span>}
                <p className="hint">
                  Then install it. iPhone: tap Share, then Add to Home Screen. Android: tap Install app (or ⋮, Install
                  app). Only devices signed in to your Tailscale can open this address. Videos still render on this Mac,
                  so leave it awake.
                </p>
              </div>
            </div>
          ) : (
            <ol className="setup-steps">
              <li className={s.installed ? 'done' : ''}>
                <strong>Install Tailscale on this Mac and on your phones.</strong> It's free:{' '}
                <a href="https://tailscale.com/download" target="_blank" rel="noreferrer">
                  tailscale.com/download
                </a>
                . This looks like a work Mac, so check that IT is OK with it.
              </li>
              <li className={s.running ? 'done' : ''}>
                <strong>Sign in to the same account on each device</strong> and switch Tailscale on.
              </li>
              <li>
                <strong>Share Reframe with your devices.</strong> In the reframe folder run{' '}
                <button className="code" onClick={() => copy('make phone')} title="Copy">
                  make phone <Copy size={12} />
                </button>
                {copied && <span className="muted"> Copied</span>}. The first time, Tailscale may ask you to turn on
                HTTPS for your account; follow its link.
              </li>
            </ol>
          )}
        </div>
        <footer className="hint">
          {url
            ? 'This page updates on its own.'
            : 'This page checks every few seconds and shows a QR code as soon as Reframe is shared.'}
        </footer>
      </div>
    </>
  )
}
