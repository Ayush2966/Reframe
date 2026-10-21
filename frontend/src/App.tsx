import { Component, useEffect, useState, type ReactNode } from 'react'
import { Home } from './components/Home'
import { Editor } from './components/Editor'

class Boundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (!this.state.error) return this.props.children
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100%', padding: 24 }}>
        <div style={{ display: 'grid', gap: 12, maxWidth: 520, textAlign: 'center', justifyItems: 'center' }}>
          <strong style={{ fontSize: 17 }}>Something broke on this screen.</strong>
          <span className="muted">{this.state.error.message}</span>
          <button className="btn" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      </div>
    )
  }
}

function route() {
  const m = window.location.hash.match(/^#\/v\/([0-9a-f]{16})/)
  return m ? m[1] : null
}

export default function App() {
  const [projectId, setProjectId] = useState(route)
  useEffect(() => {
    const on = () => setProjectId(route())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return <Boundary key={projectId ?? 'home'}>{projectId ? <Editor id={projectId} /> : <Home />}</Boundary>
}
