import { useEffect, useState } from 'react'
import { Row, Col, Empty } from 'antd'
import {
  RadialBarChart, RadialBar, ResponsiveContainer,
  LineChart, Line, XAxis, Tooltip as RTooltip,
} from 'recharts'
import { vmApi } from '../api/client'
import type { VMStats, GuestAgentStatus } from '../types'

const MAX_HISTORY = 100

function fmtBytes(b: number) {
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)}MB`
  if (b >= 1024) return `${(b / 1024).toFixed(0)}KB`
  return `${b}B`
}

function GaugeCard({ label, value, color }: { label: string; value: number; color: string }) {
  const data = [{ value, fill: color }]
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <ResponsiveContainer width="100%" height={120}>
        <RadialBarChart
          cx="50%" cy="80%"
          innerRadius="60%" outerRadius="90%"
          startAngle={180} endAngle={0}
          data={data}
          barSize={12}
        >
          <RadialBar dataKey="value" cornerRadius={4} background={{ fill: 'rgba(255,255,255,0.05)' }} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="stat-value" style={{ color, marginTop: -24 }}>{value.toFixed(1)}%</div>
    </div>
  )
}

function SparkCard({ label, data, dataKey, color, fmt }: {
  label: string; data: any[]; dataKey: string; color: string; fmt?: (v: number) => string
}) {
  return (
    <div className="stat-card" style={{ textAlign: 'left' }}>
      <div className="stat-label">{label}</div>
      <ResponsiveContainer width="100%" height={60}>
        <LineChart data={data}>
          <Line type="monotone" dataKey={dataKey} stroke={color} dot={false} strokeWidth={2} />
          <RTooltip
            formatter={(v: number) => fmt ? fmt(v) : v}
            contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid rgba(0,212,255,0.3)', fontSize: 11 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

const AGENT_STYLE: Record<string, { color: string; dot: string; label: string; desc: string }> = {
  online:   { color: 'var(--color-green)',  dot: '●', label: '系统正常',   desc: 'Guest Agent 在线，操作系统运行正常' },
  booting:  { color: 'var(--color-yellow)', dot: '●', label: '系统启动中', desc: 'VM 运行中但 Guest Agent 未响应，可能仍在引导' },
  no_agent: { color: 'var(--color-text-dim)', dot: '○', label: '未配置 Agent', desc: '未安装或未配置 QEMU Guest Agent' },
  offline:  { color: 'var(--color-text-dim)', dot: '○', label: '未运行',   desc: 'VM 未运行' },
}

function GuestAgentCard({ agent }: { agent: GuestAgentStatus }) {
  const s = AGENT_STYLE[agent.status] ?? AGENT_STYLE.offline
  return (
    <div style={{
      padding: '12px 16px',
      background: 'var(--bg-card)',
      border: `1px solid ${agent.status === 'online' ? 'rgba(0,255,136,0.25)' : agent.status === 'booting' ? 'rgba(255,204,0,0.25)' : 'rgba(0,212,255,0.12)'}`,
      borderRadius: 6,
      marginBottom: 16,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: agent.status === 'online' ? 10 : 0 }}>
        <span style={{ color: s.color, fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: 1 }}>
          {s.dot} OS STATUS
        </span>
        <span style={{ color: s.color, fontWeight: 600, fontSize: 13 }}>{s.label}</span>
        <span style={{ color: 'var(--color-text-dim)', fontSize: 11 }}>{s.desc}</span>
      </div>
      {agent.status === 'online' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginTop: 4 }}>
          {agent.hostname && (
            <div>
              <span style={{ color: 'var(--color-text-dim)', fontSize: 11, marginRight: 6 }}>HOSTNAME</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-cyan)' }}>{agent.hostname}</span>
            </div>
          )}
          {agent.os_name && (
            <div>
              <span style={{ color: 'var(--color-text-dim)', fontSize: 11, marginRight: 6 }}>OS</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}>{agent.os_name}</span>
            </div>
          )}
          {agent.kernel && (
            <div>
              <span style={{ color: 'var(--color-text-dim)', fontSize: 11, marginRight: 6 }}>KERNEL</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-text)' }}>{agent.kernel}</span>
            </div>
          )}
          {agent.ips && agent.ips.length > 0 && (
            <div>
              <span style={{ color: 'var(--color-text-dim)', fontSize: 11, marginRight: 6 }}>IPs</span>
              {agent.ips
                .filter(ip => ip.type === 'ipv4')
                .map((ip, i) => (
                  <span key={i} style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--color-green)', marginRight: 8 }}>
                    {ip.iface}: {ip.ip}
                  </span>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function MonitorPanel({ name, running }: { name: string; running: boolean }) {
  const [stats, setStats] = useState<VMStats | null>(null)
  const [history, setHistory] = useState<(VMStats & { t: number })[]>([])
  const [agent, setAgent] = useState<GuestAgentStatus | null>(null)

  useEffect(() => {
    if (!running) { setStats(null); setHistory([]); setAgent(null); return }
    const loadStats = async () => {
      try {
        const s = await vmApi.getStats(name)
        setStats(s)
        setHistory(prev => [...prev.slice(-MAX_HISTORY + 1), { ...s, t: Date.now() }])
      } catch {}
    }
    const loadAgent = async () => {
      try { setAgent(await vmApi.getGuestAgent(name)) } catch {}
    }
    loadStats()
    loadAgent()
    const t1 = setInterval(loadStats, 3000)
    const t2 = setInterval(loadAgent, 15000)
    return () => { clearInterval(t1); clearInterval(t2) }
  }, [name, running])

  if (!running) return <Empty description="VM 未运行" style={{ padding: 40 }} />

  return (
    <div style={{ padding: '8px 0' }}>
      {/* Guest Agent Status */}
      <GuestAgentCard agent={agent ?? { status: 'offline' }} />

      {!stats && <div style={{ color: 'var(--color-text-dim)', padding: 20 }}>加载中...</div>}
      {stats && <>
        {/* Gauges */}
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={24} sm={8}>
            <GaugeCard label="CPU USAGE" value={stats.cpu_percent} color="var(--color-cyan)" />
          </Col>
          <Col xs={24} sm={8}>
            <GaugeCard label="MEMORY USAGE" value={stats.mem_percent} color="var(--color-purple)" />
          </Col>
          <Col xs={24} sm={8}>
            <div className="stat-card">
              <div className="stat-label">MEMORY</div>
              <div className="stat-value" style={{ fontSize: 20, marginTop: 24 }}>
                {stats.mem_used_mb}
              </div>
              <div style={{ color: 'var(--color-text-dim)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                / {stats.mem_total_mb} MiB
              </div>
            </div>
          </Col>
        </Row>

        {/* Sparklines */}
        <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
          <Col xs={24} sm={8}>
            <SparkCard label="CPU TREND" data={history} dataKey="cpu_percent" color="var(--color-cyan)" fmt={v => `${v.toFixed(1)}%`} />
          </Col>
          <Col xs={24} sm={8}>
            <SparkCard label="MEM TREND" data={history} dataKey="mem_percent" color="var(--color-purple)" fmt={v => `${v.toFixed(1)}%`} />
          </Col>
          <Col xs={24} sm={8}>
            <SparkCard label="NET TX" data={history} dataKey="net_tx_bytes" color="var(--color-green)" fmt={fmtBytes} />
          </Col>
        </Row>

        {/* Per-interface */}
        {stats.interfaces.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{ color: 'var(--color-text-dim)', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
              Network Interfaces
            </div>
            {stats.interfaces.map(iface => (
              <div key={iface.dev} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '8px 12px', marginBottom: 4,
                background: 'rgba(0,212,255,0.03)', border: '1px solid rgba(0,212,255,0.1)', borderRadius: 4,
              }}>
                <span className="mono" style={{ color: 'var(--color-cyan)' }}>{iface.dev}</span>
                <span className="mono" style={{ color: 'var(--color-text-dim)', fontSize: 11 }}>{iface.mac}</span>
                <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                  <span style={{ color: 'var(--color-green)' }}>↑ {fmtBytes(iface.tx_bytes)}</span>
                  {' / '}
                  <span style={{ color: 'var(--color-cyan)' }}>↓ {fmtBytes(iface.rx_bytes)}</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </>}
    </div>
  )
}
