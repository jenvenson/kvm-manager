import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Col, Row, Space, Button, message, Typography, Tag, Tooltip } from 'antd'
import {
  PlayCircleOutlined, PoweroffOutlined, ThunderboltOutlined,
  DesktopOutlined, WarningOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { vmApi, protectionApi, consoleApi } from '../api/client'
import type { VMSummary, ProtectionConfig, VMStats, GuestAgentStatus } from '../types'

const STATE_TAG: Record<string, { color: string; label: string }> = {
  running:     { color: '#00ff88', label: 'RUNNING' },
  shutoff:     { color: '#4a6080', label: 'OFFLINE' },
  paused:      { color: '#ffcc00', label: 'PAUSED' },
  crashed:     { color: '#ff4d6d', label: 'CRASHED' },
}

function MiniBar({ percent, color = 'var(--color-cyan)' }: { percent: number; color?: string }) {
  return (
    <div className="mini-bar-track">
      <div className="mini-bar-fill" style={{ width: `${Math.min(100, percent)}%`, background: color }} />
    </div>
  )
}

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}

function VMCard({ vm, protection, stats, guestAgent, onAction }: {
  vm: VMSummary
  protection: ProtectionConfig
  stats: VMStats | undefined
  guestAgent: GuestAgentStatus | undefined
  onAction: () => void
}) {
  const navigate = useNavigate()
  const running = vm.state === 'running'
  const prot = protection[vm.name]
  const isCritical = prot?.level === 'critical'
  const stateInfo = STATE_TAG[vm.state] ?? { color: '#4a6080', label: vm.state.toUpperCase() }

  const doAction = async (fn: () => Promise<unknown>, label: string) => {
    try { await fn(); message.success(label); onAction() }
    catch { message.error('操作失败') }
  }

  const openConsole = async () => {
    try {
      const info = await consoleApi.getUrl(vm.name)
      window.open(info.url, '_blank')
    } catch { message.error('获取控制台失败') }
  }

  const cpuPct = stats?.cpu_percent ?? 0
  const memPct = stats?.mem_percent ?? 0

  const agentColor = guestAgent?.status === 'online' ? 'var(--color-green)'
    : guestAgent?.status === 'booting' ? 'var(--color-yellow)'
    : 'var(--color-text-dim)'
  const agentLabel = guestAgent?.status === 'online' ? '系统正常'
    : guestAgent?.status === 'booting' ? '启动中'
    : guestAgent?.status === 'no_agent' ? '无Agent'
    : ''

  return (
    <div
      className={`cyber-card ${running ? 'vm-running-glow' : ''} ${isCritical ? 'vm-critical-border' : ''}`}
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${running ? 'rgba(0,255,136,0.3)' : 'rgba(0,212,255,0.15)'}`,
        borderRadius: 8,
        padding: 16,
        cursor: 'pointer',
        transition: 'all 0.3s',
        position: 'relative',
      }}
      onClick={() => navigate(`/vm/${vm.name}`)}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space>
          {isCritical && <Tooltip title={prot.note || '关键基础设施'}><WarningOutlined style={{ color: 'var(--color-red)' }} /></Tooltip>}
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--color-text)', fontSize: 14 }}>
            {vm.name}
          </span>
        </Space>
        <Space>
          <Tag style={{ background: 'transparent', border: `1px solid ${stateInfo.color}`, color: stateInfo.color, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
            {stateInfo.label}
          </Tag>
          {running && agentLabel && (
            <span style={{ fontSize: 10, color: agentColor, fontFamily: 'var(--font-mono)' }}>
              ● {agentLabel}
            </span>
          )}
        </Space>
      </div>

      {/* Stats */}
      <div style={{ fontSize: 12, color: 'var(--color-text-dim)', marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>CPU {running ? `${cpuPct.toFixed(1)}%` : `${vm.vcpus} vCPU`}</span>
          <span className="mono">{vm.vcpus} vCPU</span>
        </div>
        <MiniBar percent={running ? cpuPct : 0} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span>MEM {running ? `${memPct.toFixed(1)}%` : `${vm.memory_mb} MiB`}</span>
          <span className="mono">{vm.memory_mb} MiB</span>
        </div>
        <MiniBar percent={running ? memPct : 0} color="var(--color-purple)" />
        {running && stats && (
          <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            <span style={{ color: 'var(--color-green)' }}>↑ {fmtBytes(stats.net_tx_bytes)}</span>
            {' / '}
            <span style={{ color: 'var(--color-cyan)' }}>↓ {fmtBytes(stats.net_rx_bytes)}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
        <Button size="small" icon={<PlayCircleOutlined />} disabled={running}
          onClick={() => doAction(() => vmApi.start(vm.name), '已启动')}
          style={{ fontSize: 11, height: 26 }}>启动</Button>
        <Button size="small" icon={<PoweroffOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.shutdown(vm.name), '已关机')}
          style={{ fontSize: 11, height: 26 }}>关机</Button>
        <Button size="small" icon={<ReloadOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.reboot(vm.name), '已重启')}
          style={{ fontSize: 11, height: 26 }}>重启</Button>
        <Button size="small" danger icon={<ThunderboltOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.forceOff(vm.name), '已强制关机')}
          style={{ fontSize: 11, height: 26 }}>强制</Button>
        <Button size="small" icon={<DesktopOutlined />} disabled={!running}
          onClick={openConsole}
          style={{ fontSize: 11, height: 26, borderColor: 'var(--color-purple)', color: 'var(--color-purple)' }}>
          控制台
        </Button>
      </div>
    </div>
  )
}

export default function Dashboard() {
  const [vms, setVms] = useState<VMSummary[]>([])
  const [protection, setProtection] = useState<ProtectionConfig>({})
  const [statsMap, setStatsMap] = useState<Record<string, VMStats>>({})
  const [agentMap, setAgentMap] = useState<Record<string, GuestAgentStatus>>({})

  const loadVms = useCallback(() =>
    vmApi.list().then(setVms).catch(() => message.error('加载失败')), [])

  const loadStats = useCallback((list: VMSummary[]) => {
    list.filter(v => v.state === 'running').forEach(v => {
      vmApi.getStats(v.name).then(s => setStatsMap(prev => ({ ...prev, [v.name]: s }))).catch(() => {})
    })
  }, [])

  const loadAgents = useCallback((list: VMSummary[]) => {
    list.filter(v => v.state === 'running').forEach(v => {
      vmApi.getGuestAgent(v.name).then(s => setAgentMap(prev => ({ ...prev, [v.name]: s }))).catch(() => {})
    })
  }, [])

  useEffect(() => {
    protectionApi.get().then(setProtection).catch(() => {})
    loadVms()
  }, [])

  useEffect(() => {
    if (vms.length) { loadStats(vms); loadAgents(vms) }
    const t = setInterval(() => {
      loadVms().then(() => { loadStats(vms); loadAgents(vms) })
    }, 5000)
    return () => clearInterval(t)
  }, [vms.length])

  const running = vms.filter(v => v.state === 'running').length

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
          VIRTUAL MACHINE MATRIX
        </Typography.Title>
        <span style={{ color: 'var(--color-text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {running} RUNNING / {vms.length} TOTAL
        </span>
      </div>

      <Row gutter={[16, 16]}>
        {vms.map(vm => (
          <Col key={vm.name} xs={24} sm={12} md={8} lg={6}>
            <VMCard
              vm={vm}
              protection={protection}
              stats={statsMap[vm.name]}
              guestAgent={agentMap[vm.name]}
              onAction={loadVms}
            />
          </Col>
        ))}
      </Row>
    </div>
  )
}
