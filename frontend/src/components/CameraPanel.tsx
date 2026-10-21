import { useCamera } from '../camera-context'
import { isTouch } from '../device'
import { useEditor } from '../store'

export function CameraPanel() {
  const target = useEditor((s) => s.target)
  const smoothness = useEditor((s) => s.smoothness)
  const seeds = useEditor((s) => s.seeds)
  const analysis = useEditor((s) => s.analysis)
  const shapes = useEditor((s) => s.shapes)
  const { coverage } = useCamera()
  const store = useEditor.getState()
  const following = shapes.some((s) => s.mode === 'follow')

  return (
    <section className="section">
      <h2>Camera</h2>
      <div className="seg" role="group" aria-label="Who to follow">
        <button aria-pressed={target === 'one'} onClick={() => store.setTarget('one')} title="Keep one person in frame">
          One person
        </button>
        <button
          aria-pressed={target === 'group'}
          onClick={() => store.setTarget('group')}
          title="Keep everyone centred"
        >
          Everyone
        </button>
      </div>

      <div className="slider">
        <label htmlFor="smooth">Movement</label>
        <output className="num" htmlFor="smooth">
          {smoothness < 0.34 ? 'Quick' : smoothness < 0.67 ? 'Smooth' : 'Steady'}
        </output>
        <input
          id="smooth"
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={smoothness}
          style={{ ['--fill' as string]: `${smoothness * 100}%` }}
          onChange={(e) => store.setSmoothness(parseFloat(e.target.value))}
        />
      </div>

      {analysis && following && (
        <div className="stat">
          <span>Subject found</span>
          <span className="num">{Math.round(coverage * 100)}% of the video</span>
        </div>
      )}
      {seeds.length > 0 && (
        <div className="stat">
          <span>
            {seeds.length} {seeds.length === 1 ? 'person picked' : 'people picked'}
          </span>
          <button className="link" onClick={() => store.clearSeeds()}>
            Let it choose again
          </button>
        </div>
      )}
      <p className="hint">
        Pause and {isTouch() ? 'tap' : 'click'} a person to follow them for the rest of that shot. Drag the frame to fix
        a moment, or drag it while the video plays to steer live.
      </p>
      {analysis && (
        <button
          className="link"
          style={{ justifySelf: 'start', fontSize: 12.5 }}
          onClick={() => store.setAnalysis(null)}
        >
          Scan for people again
        </button>
      )}
    </section>
  )
}
