import { useState, useRef, useEffect, Component } from 'react';
import type { ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { CameraControls, Sphere, Text, Html, Stars } from '@react-three/drei';
import { createXRStore, XR } from '@react-three/xr';
import * as THREE from 'three';
import './index.css';

// --- Bug reporting ---
async function reportBug(params: {
  title: string; description?: string; source?: string;
  project?: string; severity?: string; stack?: string; url?: string;
}) {
  try {
    await fetch('/api/bug-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'frontend', project: 'company-os', severity: 'high', ...params }),
    });
  } catch {}
}

// Global JS error → bug report
if (typeof window !== 'undefined') {
  window.onerror = (msg, src, line, col, err) => {
    reportBug({
      title: String(msg).slice(0, 120),
      description: `File: ${src}  Line: ${line}:${col}`,
      stack: err?.stack,
      url: window.location.href,
      severity: 'high',
    });
  };
  window.addEventListener('unhandledrejection', (e) => {
    reportBug({
      title: `Unhandled Promise: ${String(e.reason).slice(0, 120)}`,
      stack: e.reason?.stack,
      url: window.location.href,
      severity: 'medium',
    });
  });
}

// React Error Boundary
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: { componentStack: string }) {
    reportBug({
      title: `React crash: ${error.message.slice(0, 100)}`,
      description: error.message,
      stack: error.stack + '\n\nComponent stack:' + info.componentStack,
      url: window.location.href,
      severity: 'critical',
    });
  }
  render() {
    if (this.state.error) return (
      <div style={{ color: '#ff4444', padding: 32, fontFamily: 'monospace', background: '#000' }}>
        <div style={{ fontSize: 18 }}>⚠ SYSTEM ERROR — Bug report filed to GitHub</div>
        <pre style={{ fontSize: 12, opacity: 0.7, marginTop: 16 }}>{(this.state.error as Error).message}</pre>
      </div>
    );
    return this.props.children;
  }
}

const store = createXRStore();

// --- Global State ---
type Department = { id: string; name: string; agents: number; tasks: string; orbitRadius: number; orbitSpeed: number; angle: number; color: string };
type Analytics = {
  users: number; newUsers30d: number;
  revenue: string; mrr: string; churn: string;
  activeSubs?: number; orders?: number;
  sessions?: number; sessions30d?: number;
};
type Project = { id: string; name: string; position: [number, number, number]; color: string; departments: Department[]; analytics: Analytics | null };
type OsEvent = { type: string; targetId: string; payload: string; reply: string; ts: string };

const projects: Project[] = [
  {
    id: 'souloscope',
    name: 'Souloscope',
    position: [-20, 0, -10],
    color: '#00f0ff',
    analytics: null,
    departments: [
      { id: 'brand_soul', name: 'Aarya · Brand', agents: 3, tasks: 'Idle', orbitRadius: 4, orbitSpeed: 0.08, angle: 0, color: '#00f0ff' },
      { id: 'prod_soul', name: 'Dhruv · Product', agents: 5, tasks: 'Idle', orbitRadius: 5.5, orbitSpeed: 0.06, angle: Math.PI / 4, color: '#00f0ff' },
      { id: 'eng_soul', name: 'Arjun · Engineering', agents: 12, tasks: 'Idle', orbitRadius: 7, orbitSpeed: 0.05, angle: Math.PI / 2, color: '#00f0ff' },
      { id: 'devops_soul', name: 'Rohan · DevOps', agents: 4, tasks: 'Monitoring infra...', orbitRadius: 8.5, orbitSpeed: 0.04, angle: Math.PI, color: '#ffaa00' },
      { id: 'mkt_soul', name: 'Kiran · Marketing', agents: 8, tasks: 'Idle', orbitRadius: 10, orbitSpeed: 0.03, angle: Math.PI * 1.5, color: '#00f0ff' },
      { id: 'supp_soul', name: 'Priya · Support', agents: 6, tasks: 'Idle', orbitRadius: 11.5, orbitSpeed: 0.025, angle: Math.PI * 1.8, color: '#00f0ff' },
      { id: 'res_soul', name: 'Vivek · Research', agents: 4, tasks: 'Idle', orbitRadius: 13, orbitSpeed: 0.02, angle: Math.PI * 2.2, color: '#00f0ff' },
    ]
  },
  {
    id: 'mindprint',
    name: 'Mindprint',
    position: [20, 0, 10],
    color: '#ff00ff',
    analytics: null,
    departments: [
      { id: 'eng_mind', name: 'Arjun · Core AI', agents: 8, tasks: 'Idle', orbitRadius: 5, orbitSpeed: 0.07, angle: 0, color: '#ff00ff' },
      { id: 'research_mind', name: 'Vivek · Research', agents: 15, tasks: 'Analyzing patterns', orbitRadius: 7.5, orbitSpeed: 0.05, angle: Math.PI, color: '#ff00ff' },
      { id: 'devops_mind', name: 'Rohan · DevOps', agents: 3, tasks: 'Monitoring infra...', orbitRadius: 10, orbitSpeed: 0.03, angle: Math.PI * 1.5, color: '#ffaa00' }
    ]
  }
];

// --- 3D Components ---

const DepartmentNode = ({ dept, projectPos, onFocus }: { dept: Department, projectPos: [number, number, number], onFocus: (pos: [number, number, number]) => void }) => {
  const group = useRef<THREE.Group>(null);
  const [hovered, setHover] = useState(false);
  const [clicked, setClicked] = useState(false);

  // Identify all states and give them appropriate action color
  const getTaskColor = (task: string) => {
    const t = task.toLowerCase();
    if (t === 'idle') return '#555555'; // Grey for Idle
    if (t.includes('fail') || t.includes('error')) return '#ff3333'; // Red for errors
    if (t.includes('live') || t.includes('monitor') || t.includes('running') || t.includes('healthy')) return '#00ff66'; // Green for running/healthy
    if (t.includes('receiv') || t.includes('transmit')) return '#ffaa00'; // Orange for comms
    if (t.includes('analyz') || t.includes('process')) return '#00f0ff'; // Cyan for thinking
    return '#bb00ff'; // Purple for other active tasks
  };
  
  const nodeColor = getTaskColor(dept.tasks);

  useFrame((state) => {
    if (group.current) {
      const time = state.clock.elapsedTime;
      const currentAngle = dept.angle + time * dept.orbitSpeed;
      group.current.position.x = Math.cos(currentAngle) * dept.orbitRadius;
      group.current.position.z = Math.sin(currentAngle) * dept.orbitRadius;
      group.current.position.y = 0;
    }
  });

  return (
    <group 
      ref={group}
      onClick={(e) => { 
        e.stopPropagation(); 
        setClicked(!clicked);
        if (!clicked && group.current) {
          // Take it in detail: focus camera on this exact world position
          const worldX = projectPos[0] + group.current.position.x;
          const worldY = projectPos[1] + group.current.position.y;
          const worldZ = projectPos[2] + group.current.position.z;
          onFocus([worldX, worldY, worldZ]);
        }
      }}
      onPointerMissed={() => setClicked(false)}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true); }}
      onPointerOut={() => setHover(false)}
    >
      <Sphere args={[0.5, 32, 32]}>
        <meshStandardMaterial 
          color={(hovered || clicked) ? '#ffffff' : nodeColor} 
          emissive={(hovered || clicked) ? '#ffffff' : nodeColor}
          emissiveIntensity={(hovered || clicked) ? 1.5 : 0.5}
          wireframe={!hovered && !clicked}
        />
      </Sphere>

      <Text
        position={[0, 1.2, 0]}
        fontSize={0.4}
        color={(hovered || clicked) ? '#ffffff' : nodeColor}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.02}
        outlineColor="#000000"
      >
        {dept.name}
      </Text>

      {/* Floating status ticker — visible whenever not idle, no click needed */}
      {dept.tasks !== 'Idle' && !clicked && (
        <Html position={[0, 2.2, 0]} center distanceFactor={15}>
          <div style={{
            background: 'rgba(5, 10, 20, 0.85)',
            border: `1px solid ${nodeColor}`,
            boxShadow: `0 0 12px ${nodeColor}60`,
            padding: '5px 10px',
            borderRadius: '4px',
            color: nodeColor,
            fontFamily: 'monospace',
            fontSize: '0.65rem',
            maxWidth: '180px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            pointerEvents: 'none',
            letterSpacing: '0.5px',
          }}>
            ▶ {dept.tasks}
          </div>
        </Html>
      )}

      {clicked && (
        <Html position={[0, 2, 0]} center distanceFactor={15}>
          <div style={{
            background: 'rgba(5, 10, 20, 0.9)',
            border: `1px solid ${nodeColor}`,
            boxShadow: `0 0 20px ${nodeColor}40`,
            padding: '15px',
            borderRadius: '8px',
            color: '#fff',
            fontFamily: 'monospace',
            width: '200px',
            pointerEvents: 'none'
          }}>
            <h3 style={{ color: nodeColor, marginTop: 0, borderBottom: `1px solid ${nodeColor}`, paddingBottom: '5px' }}>
              {dept.name} SATELLITE
            </h3>
            <div style={{ margin: '10px 0' }}>
              <strong style={{ color: '#aaa' }}>AGENTS ONLINE:</strong><br/>
              <span style={{ fontSize: '1.2em' }}>{dept.agents}</span>
            </div>
            <div>
              <strong style={{ color: '#aaa' }}>CURRENT FOCUS:</strong><br/>
              <span style={{ color: nodeColor }}>{dept.tasks}</span>
            </div>
          </div>
        </Html>
      )}
    </group>
  );
};


const ProjectSystem = ({ project, onFocus }: { project: Project, onFocus: (pos: [number,number,number]) => void }) => {
  const planetRef = useRef<THREE.Mesh>(null);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const a = project.analytics;

  useFrame(() => {
    if (planetRef.current) planetRef.current.rotation.y += 0.005;
  });

  return (
    <group position={new THREE.Vector3(...project.position)}>
      {/* Central Planet */}
      <Sphere
        ref={planetRef}
        args={[2, 64, 64]}
        onClick={(e) => { e.stopPropagation(); setShowAnalytics(v => !v); onFocus(project.position); }}
        onPointerOver={() => document.body.style.cursor = 'pointer'}
        onPointerOut={() => document.body.style.cursor = 'auto'}
      >
        <meshPhysicalMaterial
          color="#000000"
          emissive={project.color}
          emissiveIntensity={showAnalytics ? 0.5 : 0.2}
          wireframe
          transparent
          opacity={0.3}
          roughness={0.2}
          metalness={0.8}
        />
      </Sphere>

      {/* Inner Core */}
      <Sphere args={[1.8, 32, 32]}>
        <meshStandardMaterial color={project.color} emissive={project.color} emissiveIntensity={showAnalytics ? 1 : 0.5} />
      </Sphere>

      <Text
        position={[0, 3.5, 0]}
        fontSize={1}
        color={project.color}
        anchorX="center"
        anchorY="middle"
        outlineWidth={0.05}
        outlineColor="#000000"
      >
        {project.name.toUpperCase()}
      </Text>

      {/* Analytics overlay on orb click */}
      {showAnalytics && (
        <Html position={[0, 0, 0]} center distanceFactor={20}>
          <div style={{
            background: 'rgba(4,8,20,0.97)',
            border: `1px solid ${project.color}`,
            boxShadow: `0 0 30px ${project.color}40`,
            borderRadius: '10px',
            padding: '16px',
            width: '230px',
            fontFamily: 'monospace',
            color: '#fff',
            pointerEvents: 'none',
          }}>
            <div style={{ color: project.color, fontWeight: 'bold', fontSize: '0.7rem', letterSpacing: '2px', borderBottom: `1px solid ${project.color}40`, paddingBottom: '8px', marginBottom: '12px' }}>
              {project.name.toUpperCase()} · LIVE ANALYTICS
            </div>

            {!a ? (
              <div style={{ color: '#444', fontSize: '0.7rem', textAlign: 'center', padding: '10px 0' }}>Loading...</div>
            ) : (
              <>
                {/* Users */}
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                    <span style={{ color: '#888' }}>USERS</span>
                    <span style={{ color: project.color }}>{a.users.toLocaleString()} <span style={{ color: '#00ff88', fontSize: '0.6rem' }}>+{a.newUsers30d} this mo</span></span>
                  </div>
                </div>

                {/* Revenue */}
                <div style={{ marginBottom: '10px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                    <span style={{ color: '#888' }}>REVENUE</span>
                    <span style={{ color: '#00ff88' }}>{a.revenue}</span>
                  </div>
                </div>

                {/* Sessions (Mindprint only) */}
                {a.sessions !== undefined && (
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                      <span style={{ color: '#888' }}>SESSIONS</span>
                      <span style={{ color: project.color }}>{a.sessions} <span style={{ color: '#00ff88', fontSize: '0.6rem' }}>+{a.sessions30d} this mo</span></span>
                    </div>
                  </div>
                )}

                {/* Subs (Souloscope only) */}
                {a.activeSubs !== undefined && (
                  <div style={{ marginBottom: '10px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.65rem' }}>
                      <span style={{ color: '#888' }}>ACTIVE SUBS</span>
                      <span style={{ color: project.color }}>{a.activeSubs}</span>
                    </div>
                  </div>
                )}

                {/* KPIs row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px', borderTop: `1px solid ${project.color}20`, paddingTop: '10px', marginTop: '4px' }}>
                  {[
                    { label: 'MRR', value: a.mrr },
                    { label: 'CHURN', value: a.churn },
                  ].map(k => (
                    <div key={k.label} style={{ textAlign: 'center' }}>
                      <div style={{ color: '#444', fontSize: '0.55rem', letterSpacing: '1px' }}>{k.label}</div>
                      <div style={{ color: '#e2e8f0', fontSize: '0.72rem', fontWeight: 'bold', marginTop: '2px' }}>{k.value}</div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </Html>
      )}


      {/* Orbit Rings */}
      {project.departments.map(dept => (
        <group key={`ring-${dept.id}`} rotation={[-Math.PI / 2, 0, 0]}>
          <mesh>
            <ringGeometry args={[dept.orbitRadius - 0.02, dept.orbitRadius + 0.02, 64]} />
            <meshBasicMaterial color={project.color} transparent opacity={0.1} side={THREE.DoubleSide} />
          </mesh>
        </group>
      ))}

      {/* Satellites */}
      {project.departments.map(dept => (
        <DepartmentNode 
          key={dept.id} 
          dept={dept} 
          projectPos={project.position}
          onFocus={onFocus}
        />
      ))}
    </group>
  );
};

const NavigationHUD = ({ projectsState, onFocus }: { projectsState: Project[], onFocus: (pos: [number,number,number], isOverview: boolean) => void }) => {
  return (
    <div style={{
      position: 'fixed',
      top: '20px',
      left: '20px',
      zIndex: 100,
      background: 'rgba(5, 10, 20, 0.8)',
      backdropFilter: 'blur(10px)',
      border: '1px solid #ffffff',
      boxShadow: '0 0 30px rgba(255, 255, 255, 0.2)',
      padding: '20px',
      borderRadius: '12px',
      width: '250px',
      color: '#fff',
      fontFamily: 'monospace',
      display: 'flex',
      flexDirection: 'column',
      gap: '10px'
    }}>
      <div style={{ borderBottom: '1px solid #ffffff', paddingBottom: '10px', marginBottom: '5px', color: '#ffffff', fontWeight: 'bold' }}>
        GALACTIC MAP
      </div>
      
      <button 
        onClick={() => onFocus([0, 0, 0], true)}
        style={{ background: 'transparent', color: '#fff', border: '1px solid #fff', padding: '10px', cursor: 'pointer', textAlign: 'left', transition: '0.2s' }}
        onMouseOver={e => e.currentTarget.style.background = 'rgba(255,255,255,0.2)'}
        onMouseOut={e => e.currentTarget.style.background = 'transparent'}
      >
        [ SYSTEM OVERVIEW ]
      </button>

      {projectsState.map(p => (
        <button 
          key={p.id}
          onClick={() => onFocus(p.position, false)}
          style={{ background: 'transparent', color: p.color, border: `1px solid ${p.color}`, padding: '10px', cursor: 'pointer', textAlign: 'left', transition: '0.2s' }}
          onMouseOver={e => e.currentTarget.style.background = `${p.color}40`}
          onMouseOut={e => e.currentTarget.style.background = 'transparent'}
        >
          {p.name.toUpperCase()} SYSTEM
        </button>
      ))}
    </div>
  );
};

// CMD-style footer terminal
const CommandTerminal = ({ onDispatch, projectsState }: { onDispatch: (cmd: string, targetId: string) => void, projectsState: Project[] }) => {
  const [cmd, setCmd] = useState('');
  const [target, setTarget] = useState('eng_soul');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!cmd.trim()) return;
    onDispatch(cmd.trim(), target);
    setCmd('');
    inputRef.current?.focus();
  };

  const selectedDept = projectsState.flatMap(p => p.departments).find(d => d.id === target);
  const selectedProject = projectsState.find(p => p.departments.some(d => d.id === target));

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: '280px',
      zIndex: 100,
      background: 'rgba(4, 8, 16, 0.95)',
      backdropFilter: 'blur(12px)',
      borderTop: '1px solid rgba(0,240,255,0.25)',
      padding: '10px 16px',
      fontFamily: 'monospace',
      display: 'flex',
      alignItems: 'center',
      gap: '10px',
    }}>
      {/* prompt label */}
      <span style={{ color: '#555', fontSize: '0.75rem', whiteSpace: 'nowrap' }}>QUCOS://</span>
      <select
        value={target}
        onChange={e => setTarget(e.target.value)}
        style={{
          background: 'transparent',
          color: selectedProject?.color || '#00f0ff',
          border: 'none',
          outline: 'none',
          fontFamily: 'monospace',
          fontSize: '0.78rem',
          cursor: 'pointer',
          maxWidth: '180px',
        }}
      >
        {projectsState.flatMap(p =>
          p.departments.map(d => (
            <option key={d.id} value={d.id} style={{ background: '#050a14', color: p.color }}>
              {p.name}/{d.name}
            </option>
          ))
        )}
      </select>
      <span style={{ color: selectedProject?.color || '#00f0ff', fontSize: '0.85rem' }}>{'>'}</span>
      <form onSubmit={handleSubmit} style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '8px' }}>
        <input
          ref={inputRef}
          type="text"
          value={cmd}
          onChange={e => setCmd(e.target.value)}
          placeholder={`directive to ${selectedDept?.name || 'satellite'}…`}
          autoFocus
          style={{
            flex: 1,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#e2e8f0',
            fontFamily: 'monospace',
            fontSize: '0.85rem',
            caretColor: '#00f0ff',
          }}
        />
        <button
          type="submit"
          style={{
            background: 'transparent',
            border: '1px solid rgba(0,240,255,0.4)',
            color: '#00f0ff',
            fontFamily: 'monospace',
            fontSize: '0.72rem',
            padding: '4px 12px',
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
        >
          TRANSMIT ↵
        </button>
      </form>
    </div>
  );
};

// Right-panel Event Bus
const ActivityLog = ({ events }: { events: OsEvent[] }) => {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  const typeColor: Record<string, string> = {
    'task.dispatched': '#ffaa00',
    'task.completed': '#00f0ff',
    'task.failed': '#ff4444',
  };

  const typeLabel: Record<string, string> = {
    'task.dispatched': 'SENT',
    'task.completed': 'DONE',
    'task.failed': 'FAIL',
  };

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      right: 0,
      bottom: 0,
      width: '280px',
      zIndex: 100,
      background: 'rgba(4, 8, 16, 0.92)',
      backdropFilter: 'blur(12px)',
      borderLeft: '1px solid rgba(0,240,255,0.15)',
      display: 'flex',
      flexDirection: 'column',
      fontFamily: 'monospace',
    }}>
      {/* header */}
      <div style={{
        padding: '14px 14px 10px',
        borderBottom: '1px solid rgba(0,240,255,0.15)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <span style={{ color: '#00f0ff', fontSize: '0.7rem', letterSpacing: '2px' }}>EVENT BUS</span>
        <span style={{ color: '#00ff88', fontSize: '0.65rem' }}>● LIVE</span>
      </div>

      {/* feed */}
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '10px 0' }}>
        {events.length === 0 && (
          <div style={{ color: '#333', fontSize: '0.7rem', textAlign: 'center', padding: '30px 14px' }}>
            Awaiting transmissions...
          </div>
        )}
        {events.map((ev, i) => (
          <div key={i} style={{
            borderLeft: `2px solid ${typeColor[ev.type] || '#333'}`,
            marginBottom: '1px',
            padding: '7px 10px 7px 10px',
            background: i === events.length - 1 ? 'rgba(0,240,255,0.04)' : 'transparent',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '3px' }}>
              <span style={{ color: typeColor[ev.type] || '#555', fontSize: '0.6rem', fontWeight: 'bold', letterSpacing: '1px' }}>
                {typeLabel[ev.type] || ev.type}
              </span>
              <span style={{ color: '#333', fontSize: '0.6rem' }}>
                {new Date(ev.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
              </span>
            </div>
            <div style={{ color: '#667', fontSize: '0.65rem', marginBottom: '2px' }}>{ev.targetId}</div>
            <div style={{ color: '#8898aa', fontSize: '0.65rem', lineHeight: 1.4 }}>
              {ev.payload?.slice(0, 60)}{(ev.payload?.length ?? 0) > 60 ? '…' : ''}
            </div>
            {ev.reply && ev.type !== 'task.dispatched' && (
              <div style={{ color: typeColor[ev.type] || '#00f0ff', fontSize: '0.65rem', marginTop: '4px', lineHeight: 1.4, opacity: 0.85 }}>
                {ev.reply.slice(0, 100)}{ev.reply.length > 100 ? '…' : ''}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* footer count */}
      <div style={{ padding: '8px 14px', borderTop: '1px solid rgba(0,240,255,0.1)', color: '#333', fontSize: '0.6rem' }}>
        {events.length} events
      </div>
    </div>
  );
};

const CameraController = ({ focusTarget }: { focusTarget: { target: [number,number,number], isOverview: boolean } | null }) => {
  const controlsRef = useRef<CameraControls>(null);
  
  useEffect(() => {
    if (controlsRef.current && focusTarget) {
      if (focusTarget.isOverview) {
        controlsRef.current.setLookAt(0, 15, 30, 0, 0, 0, true);
      } else {
        controlsRef.current.setLookAt(
          focusTarget.target[0], focusTarget.target[1] + 10, focusTarget.target[2] + 15,
          focusTarget.target[0], focusTarget.target[1], focusTarget.target[2],
          true
        );
      }
    }
  }, [focusTarget]);

  return <CameraControls ref={controlsRef} />
};

const CompanyOS = () => {
  const [activeProjects, setActiveProjects] = useState<Project[]>(projects);
  const [focusTarget, setFocusTarget] = useState<{ target: [number,number,number], isOverview: boolean } | null>(null);
  const [osEvents, setOsEvents] = useState<OsEvent[]>([]);

  // Fetch live analytics and inject into project state
  useEffect(() => {
    const loadAnalytics = async () => {
      try {
        const res = await fetch('/api/analytics');
        if (!res.ok) return;
        const data = await res.json();
        setActiveProjects(current => current.map(p => ({
          ...p,
          analytics: data[p.id] ?? p.analytics,
        })));
      } catch {}
    };
    loadAnalytics();
    const iv = setInterval(loadAnalytics, 30000);
    return () => clearInterval(iv);
  }, []);

  // SSE: live event stream from Redis pub/sub
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onmessage = (e) => {
      try {
        const ev: OsEvent = JSON.parse(e.data);
        setOsEvents(prev => [...prev.slice(-49), ev]);

        // Pulse the target department when an event arrives
        if (ev.targetId) {
          setActiveProjects(current =>
            current.map(proj => ({
              ...proj,
              departments: proj.departments.map(d =>
                d.id === ev.targetId
                  ? { ...d, tasks: ev.reply || ev.payload || d.tasks }
                  : d
              )
            }))
          );
        }
      } catch {}
    };
    es.onerror = () => console.warn('SSE stream error — retrying…');
    return () => es.close();
  }, []);

  useEffect(() => {
    const fetchHealth = async () => {
      try {
        const res = await fetch('/api/health');
        if (!res.ok) return;
        const h = await res.json();

        const parts: string[] = [];
        if (h.cpu)  parts.push(`CPU ${h.cpu.load1}`);
        if (h.ram)  parts.push(`RAM ${h.ram.pct}%`);
        if (h.disk) parts.push(`DSK ${h.disk.pct}%`);
        if (h.net)  parts.push(`NET ↓${h.net.rx_mb}M ↑${h.net.tx_mb}M`);
        const summary = parts.join('  |  ');

        setActiveProjects(current =>
          current.map(proj => ({
            ...proj,
            departments: proj.departments.map(d =>
              d.id.startsWith('devops_') ? { ...d, tasks: summary || 'Monitoring...' } : d
            )
          }))
        );
      } catch (e) {
        console.error('Health fetch failed', e);
      }
    };
    
    // Poll every 3 seconds
    fetchHealth();
    const interval = setInterval(fetchHealth, 3000);
    return () => clearInterval(interval);
  }, []);

  const updateDeptTask = (deptId: string, task: string) => {
    setActiveProjects(current => 
      current.map(proj => ({
        ...proj,
        departments: proj.departments.map(d => 
          d.id === deptId ? { ...d, tasks: task } : d
        )
      }))
    );
  };

  const dispatchTask = async (cmd: string, targetId: string) => {
    updateDeptTask(targetId, 'Receiving transmission...');

    try {
      const response = await fetch('/api/dispatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId, cmd })
      });

      if (!response.body) throw new Error('No stream');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let streamed = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value);
        const lines = text.split('\n').filter(l => l.startsWith('data: '));
        for (const line of lines) {
          try {
            const chunk = JSON.parse(line.slice(6));
            if (chunk.token) {
              streamed += chunk.token;
              updateDeptTask(targetId, streamed);
            }
            if (chunk.done) {
              updateDeptTask(targetId, chunk.reply || streamed);
            }
          } catch {}
        }
      }
    } catch (e) {
      updateDeptTask(targetId, 'Transmission failed');
    }
  };

  const handleFocus = (pos: [number,number,number], isOverview: boolean = false) => {
    setFocusTarget({ target: pos, isOverview });
  };

  return (
    <>
      <NavigationHUD projectsState={activeProjects} onFocus={handleFocus} />

      {/* VR icon — bottom left, above footer */}
      <button
        onClick={() => store.enterVR()}
        title="Enter Galactic VR View"
        style={{
          position: 'fixed',
          bottom: '48px',
          left: '16px',
          zIndex: 200,
          background: 'rgba(4,8,16,0.85)',
          border: '1px solid rgba(0,240,255,0.3)',
          borderRadius: '8px',
          color: '#00f0ff',
          width: '42px',
          height: '42px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
          fontSize: '18px',
          transition: 'all 0.2s',
        }}
        onMouseOver={e => { e.currentTarget.style.background = 'rgba(0,240,255,0.15)'; e.currentTarget.style.borderColor = '#00f0ff'; }}
        onMouseOut={e => { e.currentTarget.style.background = 'rgba(4,8,16,0.85)'; e.currentTarget.style.borderColor = 'rgba(0,240,255,0.3)'; }}
      >
        ◉
      </button>

      {/* 3D Canvas — inset to avoid right panel and footer */}
      <Canvas
        style={{ position: 'fixed', top: 0, left: 0, right: '280px', bottom: '44px', background: '#000000' }}
        camera={{ position: [0, 15, 30] }}
      >
        <XR store={store}>
          <color attach="background" args={['#000000']} />
          <fog attach="fog" args={['#000000', 30, 100]} />

          <ambientLight intensity={0.1} />
          <directionalLight position={[10, 20, 10]} intensity={1.5} color="#ffffff" />

          <Stars radius={100} depth={50} count={5000} factor={4} saturation={0} fade speed={1} />

          {activeProjects.map(proj => (
            <ProjectSystem key={proj.id} project={proj} onFocus={(pos) => handleFocus(pos, false)} />
          ))}

          <CameraController focusTarget={focusTarget} />
        </XR>
      </Canvas>

      {/* Right panel */}
      <ActivityLog events={osEvents} />

      {/* Footer CMD */}
      <CommandTerminal onDispatch={dispatchTask} projectsState={activeProjects} />
    </>
  );
};

const CompanyOSWithBoundary = () => (
  <ErrorBoundary>
    <CompanyOS />
  </ErrorBoundary>
);

export default CompanyOSWithBoundary;
