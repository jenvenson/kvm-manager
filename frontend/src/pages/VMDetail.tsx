import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Space, Button, Tabs, message, Tag, Modal, Switch, Tooltip } from 'antd'
import {
  ArrowLeftOutlined, PlayCircleOutlined, PoweroffOutlined,
  ThunderboltOutlined, DesktopOutlined, WarningOutlined, LockOutlined, ReloadOutlined,
} from '@ant-design/icons'
import { vmApi, consoleApi, protectionApi } from '../api/client'
import type { VMDetail, ProtectionConfig } from '../types'
import CPUPanel from '../components/CPUPanel'
import MemoryPanel from '../components/MemoryPanel'
import DiskPanel from '../components/DiskPanel'
import UsbDiskPanel from '../components/UsbDiskPanel'
import SnapshotPanel from '../components/SnapshotPanel'
import MonitorPanel from '../components/MonitorPanel'
import NetworkPanel from '../components/NetworkPanel'
import XmlPanel from '../components/XmlPanel'

const STATE_TAG: Record<string, { color: string; label: string }> = {
  running: { color: '#00ff88', label: 'RUNNING' },
  shutoff: { color: '#4a6080', label: 'OFFLINE' },
  paused:  { color: '#ffcc00', label: 'PAUSED' },
  crashed: { color: '#ff4d6d', label: 'CRASHED' },
}

export default function VMDetailPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [vm, setVm] = useState<VMDetail | null>(null)
  const [protection, setProtection] = useState<ProtectionConfig>({})
  const [pendingAction, setPendingAction] = useState<null | { label: string; fn: () => Promise<unknown>; confirmMsg?: string }>(null)

  const load = () => { if (name) vmApi.get(name).then(setVm).catch(() => message.error('加载失败')) }

  useEffect(() => {
    load()
    protectionApi.get().then(setProtection).catch(() => {})
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [name])

  if (!vm || !name) return null
  const running = vm.state === 'running'
  const stateInfo = STATE_TAG[vm.state] ?? { color: '#4a6080', label: vm.state.toUpperCase() }
  const prot = protection[name]
  const isCritical = prot?.level === 'critical'

  const doAction = async (fn: () => Promise<unknown>, label: string, confirmMsg?: string) => {
    if (confirmMsg && !pendingAction) {
      setPendingAction({ label, fn, confirmMsg })
      return
    }
    if (isCritical && !pendingAction?.confirmMsg) {
      setPendingAction({ label, fn })
      return
    }
    try { await fn(); message.success(label); load() }
    catch { message.error('操作失败') }
    finally { setPendingAction(null) }
  }

  const confirmAction = async () => {
    if (!pendingAction) return
    if (pendingAction.confirmMsg && !isCritical) {
      // general confirm only — execute directly
      try { await pendingAction.fn(); message.success(pendingAction.label); load() }
      catch { message.error('操作失败') }
      finally { setPendingAction(null) }
      return
    }
    if (pendingAction.confirmMsg && isCritical) {
      // show critical modal next
      setPendingAction({ label: pendingAction.label, fn: pendingAction.fn })
      return
    }
    try { await pendingAction.fn(); message.success(pendingAction.label); load() }
    catch { message.error('操作失败') }
    finally { setPendingAction(null) }
  }

  const openConsole = async () => {
    try { const info = await consoleApi.getUrl(name); window.open(info.url, '_blank') }
    catch { message.error('获取控制台失败') }
  }

  const toggleProtection = async (checked: boolean) => {
    try {
      if (checked) await protectionApi.set(name, 'critical', '关键基础设施，需通过 BMC 操作')
      else await protectionApi.remove(name)
      const p = await protectionApi.get()
      setProtection(p)
      message.success(checked ? '已启用保护' : '已移除保护')
    } catch { message.error('操作失败') }
  }

  return (
    <div>
      {/* General confirm modal */}
      <Modal
        open={!!pendingAction?.confirmMsg}
        onCancel={() => setPendingAction(null)}
        onOk={confirmAction}
        okText="确认"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        title="确认操作"
      >
        <p style={{ color: 'var(--color-text)' }}>{pendingAction?.confirmMsg}</p>
      </Modal>

      {/* Critical VM warning modal */}
      <Modal
        open={!!pendingAction && !pendingAction.confirmMsg}
        onCancel={() => setPendingAction(null)}
        onOk={confirmAction}
        okText="我已知晓，继续操作"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        title={<span style={{ color: 'var(--color-red)' }}>🚨 关键基础设施警告</span>}
      >
        <p style={{ color: 'var(--color-text)' }}>
          <strong>{name}</strong> 是受保护的关键基础设施 VM。
        </p>
        <p style={{ color: 'var(--color-text)' }}>
          操作后网络或管理界面可能中断，无法通过常规方式恢复。
        </p>
        <div style={{
          background: 'rgba(255,77,109,0.08)', border: '1px solid rgba(255,77,109,0.3)',
          borderRadius: 6, padding: 12, marginTop: 12,
        }}>
          <WarningOutlined style={{ color: 'var(--color-red)', marginRight: 8 }} />
          <span style={{ color: 'var(--color-red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            恢复方式：需通过 BMC（带外管理）控制台操作
          </span>
        </div>
      </Modal>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')} size="small" />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--color-text)' }}>
            {vm.name}
          </span>
          <Tag style={{ background: 'transparent', border: `1px solid ${stateInfo.color}`, color: stateInfo.color, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {stateInfo.label}
          </Tag>
          {isCritical && (
            <Tooltip title="关键基础设施">
              <LockOutlined style={{ color: 'var(--color-red)' }} />
            </Tooltip>
          )}
        </Space>
        <Space>
          <span style={{ color: 'var(--color-text-dim)', fontSize: 12 }}>保护模式</span>
          <Switch
            checked={isCritical}
            onChange={toggleProtection}
            checkedChildren={<WarningOutlined />}
            size="small"
          />
        </Space>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<PlayCircleOutlined />} disabled={running}
          onClick={() => doAction(() => vmApi.start(name), '已启动')}>启动</Button>
        <Button icon={<PoweroffOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.shutdown(name), '已关机', `确认关机 ${name}？`)}>关机</Button>
        <Button icon={<ReloadOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.reboot(name), '已重启', `确认重启 ${name}？`)}>重启</Button>
        <Button icon={<ThunderboltOutlined />} danger disabled={!running}
          onClick={() => doAction(() => vmApi.forceOff(name), '已强制关机', `确认强制关机 ${name}？此操作相当于直接断电，可能导致数据损坏。`)}>强制关机</Button>
        <Button icon={<DesktopOutlined />} disabled={!running}
          onClick={openConsole}
          style={{ borderColor: 'var(--color-purple)', color: 'var(--color-purple)' }}>控制台</Button>
      </Space>

      <Tabs items={[
        { key: 'monitor', label: '概览', children: <MonitorPanel name={name} running={running} /> },
        { key: 'xml', label: 'XML', children: <XmlPanel name={name} /> },
        { key: 'cpu', label: 'CPU', children: <CPUPanel name={name} running={running} /> },
        { key: 'memory', label: '内存', children: <MemoryPanel name={name} running={running} /> },
        { key: 'disk', label: '磁盘', children: <DiskPanel name={name} /> },
        { key: 'network', label: '网络', children: <NetworkPanel name={name} running={running} /> },
        { key: 'usb', label: 'USB 磁盘透传', children: <UsbDiskPanel name={name} /> },
        { key: 'snapshots', label: '快照', children: <SnapshotPanel name={name} /> },
      ]} />
    </div>
  )
}
