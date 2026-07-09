import { useEffect, useState } from 'react'
import {
  Button, Table, Tag, Popconfirm, Modal, message, Divider, Tooltip, Alert,
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { usbDiskApi } from '../api/client'
import type { HostUsbDisk, UsbDiskInfo } from '../types'

export default function UsbDiskPanel({ name }: { name: string }) {
  const [hostDisks, setHostDisks] = useState<HostUsbDisk[]>([])
  const [vmDisks, setVmDisks] = useState<UsbDiskInfo[]>([])
  const [loadingHost, setLoadingHost] = useState(false)
  const [attachingDev, setAttachingDev] = useState<string | null>(null)
  const [gaModal, setGaModal] = useState<{ hostDev: string; vmDev: string } | null>(null)

  const loadVm = () =>
    usbDiskApi.listVm(name).then(setVmDisks).catch(() => message.error('加载已挂载磁盘失败'))

  const loadHost = () => {
    setLoadingHost(true)
    usbDiskApi.listHost()
      .then(setHostDisks)
      .catch(() => message.error('加载宿主机 USB 磁盘失败'))
      .finally(() => setLoadingHost(false))
  }

  useEffect(() => { loadVm(); loadHost() }, [name])

  const attach = async (disk: HostUsbDisk) => {
    setAttachingDev(disk.dev)
    try {
      await usbDiskApi.attach(name, { host_dev: disk.dev, persistent: false })
      message.success(`已挂载 ${disk.name} 到 VM`)
      loadVm()
    } catch {
      message.error('挂载失败')
    } finally {
      setAttachingDev(null)
    }
  }

  const detach = async (hostDev: string, force = false, vmDev = '') => {
    // Strip /dev/ prefix — FastAPI path params can't handle slashes
    const devName = hostDev.replace(/^\/dev\//, '')
    try {
      const res = await usbDiskApi.detach(name, devName, force)
      const data = res.data as { status: string; message?: string }
      if (data.status === 'ga_unavailable') {
        setGaModal({ hostDev, vmDev })
        return
      }
      message.success('已解挂')
      loadVm()
    } catch (e: unknown) {
      const err = e as { response?: { status?: number; data?: { detail?: string } } }
      if (err?.response?.status === 404) {
        message.warning('设备已不在 VM 配置中，已自动刷新')
        loadVm()
      } else {
        message.error(err?.response?.data?.detail || '解挂失败')
      }
    }
  }

  const forceDetach = async () => {
    if (!gaModal) return
    await detach(gaModal.hostDev, true)
    setGaModal(null)
    loadVm()
  }

  const hostCols = [
    { title: '设备', dataIndex: 'dev', width: 120 },
    { title: '型号', dataIndex: 'name' },
    { title: '大小', dataIndex: 'size_gb', width: 90, render: (v: number) => `${v} GB` },
    {
      title: '操作', width: 100,
      render: (_: unknown, r: HostUsbDisk) => (
        r.in_use
          ? (
            <Tooltip title={`已挂载到 VM：${r.used_by}`}>
              <Button size="small" type="primary" disabled>挂载</Button>
            </Tooltip>
          )
          : (
            <Button
              size="small"
              type="primary"
              loading={attachingDev === r.dev}
              onClick={() => attach(r)}
            >
              挂载
            </Button>
          )
      ),
    },
  ]

  const vmCols = [
    { title: 'VM 设备', dataIndex: 'dev', width: 100, render: (v: string) => `/dev/${v}` },
    { title: '宿主机设备', dataIndex: 'host_dev', width: 120 },
    { title: '型号', dataIndex: 'name' },
    { title: '大小', dataIndex: 'size_gb', width: 90, render: (v: number) => `${v} GB` },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) =>
        v === 'online'
          ? <Tag color="green">在线</Tag>
          : <Tag color="red">设备离线</Tag>,
    },
    {
      title: '操作', width: 80,
      render: (_: unknown, r: UsbDiskInfo) => (
        r.status === 'offline'
          ? (
            <Popconfirm
              title="设备已离线，确认从 VM 配置中移除？"
              onConfirm={() => detach(r.host_dev, true, r.dev)}
            >
              <Button danger size="small">清理</Button>
            </Popconfirm>
          )
          : (
            <Tooltip title="解挂前请在 VM 内执行 umount">
              <Button danger size="small" onClick={() => detach(r.host_dev, false, r.dev)}>解挂</Button>
            </Tooltip>
          )
      ),
    },
  ]

  return (
    <>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message="使用注意事项"
        description={
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            <li><strong>USB 磁盘透传</strong>：将插入宿主机的 USB 磁盘以 SCSI 块设备方式直接透传给虚拟机，VM 内可像使用本地磁盘一样读写</li>
            <li>挂载后宿主机仍可看到该设备（如 /dev/sdb），这是正常现象</li>
            <li>VM 使用期间，请勿在宿主机上 mount 或写入该设备，否则会导致数据损坏</li>
            <li>解挂前请先在 VM 内执行 <code>umount /dev/sdX</code>，再点击解挂</li>
            <li><strong>VM 设备列显示的是 XML 标识符，实际设备名以 VM 内 <code>lsblk</code> 结果为准</strong></li>
          </ul>
        }
      />
      <Divider orientation="left">宿主机 USB 磁盘</Divider>
      <Button
        icon={<ReloadOutlined />}
        size="small"
        loading={loadingHost}
        onClick={loadHost}
        style={{ marginBottom: 8 }}
      >
        刷新
      </Button>
      <Table
        dataSource={hostDisks}
        columns={hostCols}
        rowKey="dev"
        pagination={false}
        size="small"
      />

      <Divider orientation="left">已挂载到本 VM</Divider>
      <Table
        dataSource={vmDisks}
        columns={vmCols}
        rowKey="dev"
        pagination={false}
        size="small"
      />

      <Modal
        title="无法检测挂载状态"
        open={!!gaModal}
        onOk={forceDetach}
        onCancel={() => setGaModal(null)}
        okText="确认已 umount，强制解挂"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <p>虚拟机未安装 Guest Agent，无法自动检测设备是否已在 VM 内卸载。</p>
        <p>请确认已在 VM 内执行 <code>umount /dev/{gaModal?.vmDev}</code>，否则可能导致数据损坏。</p>
      </Modal>
    </>
  )
}
