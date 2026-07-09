import { useEffect, useState } from 'react'
import { Descriptions, Table, Tag, Spin, Alert, Typography, Divider } from 'antd'
import { vmApi } from '../api/client'

const { Title } = Typography

interface Props { name: string }

function getText(el: Element | null, selector: string) {
  return el?.querySelector(selector)?.textContent?.trim() ?? '—'
}
function getAttr(el: Element | null, selector: string, attr: string) {
  return el?.querySelector(selector)?.getAttribute(attr) ?? '—'
}

function parseXml(xmlStr: string) {
  const doc = new DOMParser().parseFromString(xmlStr, 'text/xml')
  const domain = doc.documentElement

  // Basic
  const name = getText(domain, 'name')
  const uuid = getText(domain, 'uuid')
  const description = getText(domain, 'description')
  const osType = domain.querySelector('os type')
  const arch = osType?.getAttribute('arch') ?? '—'
  const machine = osType?.getAttribute('machine') ?? '—'
  const osTypeText = osType?.textContent?.trim() ?? '—'
  const bootDevs = Array.from(domain.querySelectorAll('os boot')).map(b => b.getAttribute('dev') ?? '')

  // CPU
  const vcpuEl = domain.querySelector('vcpu')
  const vcpus = vcpuEl?.textContent?.trim() ?? '—'
  const vcpuCurrent = vcpuEl?.getAttribute('current') ?? vcpus
  const cpuMode = domain.querySelector('cpu')?.getAttribute('mode') ?? '—'
  const cpuModel = getText(domain, 'cpu model')
  const topology = domain.querySelector('cpu topology')
  const sockets = topology?.getAttribute('sockets') ?? '—'
  const cores = topology?.getAttribute('cores') ?? '—'
  const threads = topology?.getAttribute('threads') ?? '—'
  const features = Array.from(domain.querySelectorAll('cpu feature')).map(f => ({
    name: f.getAttribute('name') ?? '',
    policy: f.getAttribute('policy') ?? '',
  }))

  // Memory
  const memEl = domain.querySelector('memory')
  const curMemEl = domain.querySelector('currentMemory')
  const memUnit = memEl?.getAttribute('unit') ?? 'KiB'
  const memVal = Number(memEl?.textContent ?? 0)
  const curMemVal = Number(curMemEl?.textContent ?? 0)
  const toMb = (v: number, unit: string) => {
    if (unit === 'KiB' || unit === 'k') return Math.round(v / 1024)
    if (unit === 'MiB' || unit === 'M') return v
    if (unit === 'GiB' || unit === 'G') return v * 1024
    return Math.round(v / 1024)
  }
  const maxMb = toMb(memVal, memUnit)
  const curMb = toMb(curMemVal, curMemEl?.getAttribute('unit') ?? memUnit)
  const balloon = domain.querySelector('devices memballoon')?.getAttribute('model') ?? '—'

  // Features
  const fwFeatures = ['acpi', 'apic', 'pae', 'vmport', 'smm'].filter(f => domain.querySelector(`features ${f}`) !== null)

  // Disks
  const disks = Array.from(domain.querySelectorAll('devices disk')).map(disk => ({
    type: disk.getAttribute('type') ?? '—',
    device: disk.getAttribute('device') ?? '—',
    driver: disk.querySelector('driver')?.getAttribute('type') ?? '—',
    source: disk.querySelector('source')?.getAttribute('file') ??
            disk.querySelector('source')?.getAttribute('dev') ??
            disk.querySelector('source')?.getAttribute('volume') ?? '—',
    target: disk.querySelector('target')?.getAttribute('dev') ?? '—',
    bus: disk.querySelector('target')?.getAttribute('bus') ?? '—',
    readonly: disk.querySelector('readonly') !== null,
    boot: disk.querySelector('boot')?.getAttribute('order') ?? '',
  }))

  // Networks
  const networks = Array.from(domain.querySelectorAll('devices interface')).map(iface => ({
    type: iface.getAttribute('type') ?? '—',
    source: iface.querySelector('source')?.getAttribute('network') ??
            iface.querySelector('source')?.getAttribute('bridge') ??
            iface.querySelector('source')?.getAttribute('dev') ?? '—',
    model: iface.querySelector('model')?.getAttribute('type') ?? '—',
    mac: iface.querySelector('mac')?.getAttribute('address') ?? '—',
    boot: iface.querySelector('boot')?.getAttribute('order') ?? '',
  }))

  // Graphics
  const graphics = Array.from(domain.querySelectorAll('devices graphics')).map(g => ({
    type: g.getAttribute('type') ?? '—',
    port: g.getAttribute('port') ?? '—',
    listen: g.querySelector('listen')?.getAttribute('address') ?? g.getAttribute('listen') ?? '—',
    autoport: g.getAttribute('autoport') ?? '—',
  }))

  // Video
  const video = domain.querySelector('devices video model')
  const videoType = video?.getAttribute('type') ?? '—'
  const videoVram = video?.getAttribute('vram') ?? '—'

  // Console / Serial
  const consoles = Array.from(domain.querySelectorAll('devices console')).map(c => ({
    type: c.getAttribute('type') ?? '—',
    target: c.querySelector('target')?.getAttribute('type') ?? '—',
  }))

  return {
    name, uuid, description, arch, machine, osTypeText, bootDevs,
    vcpus, vcpuCurrent, cpuMode, cpuModel, sockets, cores, threads, features,
    maxMb, curMb, balloon, fwFeatures,
    disks, networks, graphics, videoType, videoVram, consoles,
  }
}

export default function XmlInfoPanel({ name }: Props) {
  const [info, setInfo] = useState<ReturnType<typeof parseXml> | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    vmApi.getXml(name)
      .then(r => setInfo(parseXml(r.xml)))
      .catch(() => setError('加载 XML 失败'))
  }, [name])

  if (error) return <Alert type="error" message={error} />
  if (!info) return <Spin style={{ marginTop: 40 }} />

  const diskCols = [
    { title: '设备', dataIndex: 'target', key: 'target', width: 80 },
    { title: '类型', dataIndex: 'device', key: 'device', width: 80 },
    { title: '总线', dataIndex: 'bus', key: 'bus', width: 80 },
    { title: '驱动格式', dataIndex: 'driver', key: 'driver', width: 100 },
    { title: '源路径', dataIndex: 'source', key: 'source', ellipsis: true },
    { title: '属性', key: 'flags', width: 120, render: (_: unknown, r: typeof info.disks[0]) => (
      <span>
        {r.readonly && <Tag color="orange">只读</Tag>}
        {r.boot && <Tag color="blue">Boot {r.boot}</Tag>}
      </span>
    )},
  ]

  const netCols = [
    { title: 'MAC', dataIndex: 'mac', key: 'mac', width: 160 },
    { title: '类型', dataIndex: 'type', key: 'type', width: 80 },
    { title: '源', dataIndex: 'source', key: 'source', width: 140 },
    { title: '网卡型号', dataIndex: 'model', key: 'model', width: 120 },
    { title: 'Boot', dataIndex: 'boot', key: 'boot', width: 60 },
  ]

  const labelStyle: React.CSSProperties = { color: 'var(--color-text-dim)', width: 120, fontSize: 14 }
  const monoStyle: React.CSSProperties = { fontFamily: 'var(--font-mono)', fontSize: 13 }

  return (
    <div style={{ fontSize: 14 }}>
      {/* Basic */}
      <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>基本信息</Title>
      <Descriptions column={2} size="small" labelStyle={labelStyle}>
        <Descriptions.Item label="名称"><span style={monoStyle}>{info.name}</span></Descriptions.Item>
        <Descriptions.Item label="UUID"><span style={monoStyle}>{info.uuid}</span></Descriptions.Item>
        <Descriptions.Item label="架构">{info.arch}</Descriptions.Item>
        <Descriptions.Item label="机器类型"><span style={monoStyle}>{info.machine}</span></Descriptions.Item>
        <Descriptions.Item label="OS 类型">{info.osTypeText}</Descriptions.Item>
        <Descriptions.Item label="启动顺序">
          {info.bootDevs.map((d, i) => <Tag key={i} color="blue">{i + 1}. {d}</Tag>)}
        </Descriptions.Item>
        {info.description !== '—' && (
          <Descriptions.Item label="描述" span={2}>{info.description}</Descriptions.Item>
        )}
      </Descriptions>

      <Divider style={{ borderColor: 'rgba(0,212,255,0.15)', margin: '16px 0' }} />

      {/* CPU */}
      <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>CPU</Title>
      <Descriptions column={3} size="small" labelStyle={labelStyle}>
        <Descriptions.Item label="vCPU 数"><span style={monoStyle}>{info.vcpuCurrent} / {info.vcpus} (最大)</span></Descriptions.Item>
        <Descriptions.Item label="Sockets"><span style={monoStyle}>{info.sockets}</span></Descriptions.Item>
        <Descriptions.Item label="Cores"><span style={monoStyle}>{info.cores}</span></Descriptions.Item>
        <Descriptions.Item label="Threads"><span style={monoStyle}>{info.threads}</span></Descriptions.Item>
        <Descriptions.Item label="CPU 模式">{info.cpuMode}</Descriptions.Item>
        {info.cpuModel !== '—' && <Descriptions.Item label="CPU 型号"><span style={monoStyle}>{info.cpuModel}</span></Descriptions.Item>}
      </Descriptions>
      {info.features.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span style={{ color: 'var(--color-text-dim)', fontSize: 14, marginRight: 8 }}>CPU Feature:</span>
          {info.features.map(f => (
            <Tag key={f.name} color={f.policy === 'require' ? 'green' : f.policy === 'disable' ? 'red' : 'default'}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {f.name}
            </Tag>
          ))}
        </div>
      )}

      <Divider style={{ borderColor: 'rgba(0,212,255,0.15)', margin: '16px 0' }} />

      {/* Memory */}
      <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>内存</Title>
      <Descriptions column={3} size="small" labelStyle={labelStyle}>
        <Descriptions.Item label="当前内存"><span style={monoStyle}>{info.curMb} MiB</span></Descriptions.Item>
        <Descriptions.Item label="最大内存"><span style={monoStyle}>{info.maxMb} MiB</span></Descriptions.Item>
        <Descriptions.Item label="气球设备">{info.balloon}</Descriptions.Item>
      </Descriptions>

      <Divider style={{ borderColor: 'rgba(0,212,255,0.15)', margin: '16px 0' }} />

      {/* Features */}
      <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>固件特性</Title>
      <div>
        {info.fwFeatures.length > 0
          ? info.fwFeatures.map(f => <Tag key={f} color="cyan" style={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>{f.toUpperCase()}</Tag>)
          : <span style={{ color: 'var(--color-text-dim)' }}>无</span>
        }
      </div>

      <Divider style={{ borderColor: 'rgba(0,212,255,0.15)', margin: '16px 0' }} />

      {/* Disks */}
      <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>磁盘设备</Title>
      <Table
        dataSource={info.disks}
        columns={diskCols}
        rowKey="target"
        size="small"
        pagination={false}
        style={{ marginBottom: 8 }}
      />

      <Divider style={{ borderColor: 'rgba(0,212,255,0.15)', margin: '16px 0' }} />

      {/* Networks */}
      <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>网络接口</Title>
      <Table
        dataSource={info.networks}
        columns={netCols}
        rowKey="mac"
        size="small"
        pagination={false}
        style={{ marginBottom: 8 }}
      />

      <Divider style={{ borderColor: 'rgba(0,212,255,0.15)', margin: '16px 0' }} />

      {/* Graphics & Video */}
      <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>显示 / 图形</Title>
      <Descriptions column={2} size="small" labelStyle={labelStyle}>
        {info.graphics.map((g, i) => (
          <Descriptions.Item key={i} label={`${g.type.toUpperCase()} 图形`} span={2}>
            <span style={monoStyle}>端口: {g.port}  监听: {g.listen}  自动端口: {g.autoport}</span>
          </Descriptions.Item>
        ))}
        <Descriptions.Item label="视频模型">{info.videoType}</Descriptions.Item>
        <Descriptions.Item label="视频显存"><span style={monoStyle}>{info.videoVram} KiB</span></Descriptions.Item>
      </Descriptions>

      {info.consoles.length > 0 && (
        <>
          <Divider style={{ borderColor: 'rgba(0,212,255,0.15)', margin: '16px 0' }} />
          <Title level={5} style={{ color: 'var(--color-cyan)', marginBottom: 12 }}>控制台 / 串口</Title>
          <Descriptions column={2} size="small" labelStyle={labelStyle}>
            {info.consoles.map((c, i) => (
              <Descriptions.Item key={i} label={`Console ${i + 1}`}>
                {c.type} / {c.target}
              </Descriptions.Item>
            ))}
          </Descriptions>
        </>
      )}
    </div>
  )
}
