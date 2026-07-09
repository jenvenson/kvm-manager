import { useEffect, useState } from 'react'
import { Button, Space, Alert, Spin, message, Typography } from 'antd'
import { ReloadOutlined, SaveOutlined } from '@ant-design/icons'
import { vmApi } from '../api/client'

const { Text } = Typography

interface Props { name: string }

export default function XmlEditorPanel({ name }: Props) {
  const [xml, setXml] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const load = () => {
    setLoading(true)
    setError('')
    vmApi.getXml(name)
      .then(r => setXml(r.xml))
      .catch(() => setError('加载 XML 失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [name])

  const save = async () => {
    setSaving(true)
    try {
      await vmApi.updateXml(name, xml)
      message.success('XML 已更新，部分更改需重启 VM 后生效')
    } catch (e: unknown) {
      const detail = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail
      message.error(detail ?? '保存失败，请检查 XML 格式')
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <Spin style={{ marginTop: 40 }} />

  return (
    <div>
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        message={
          <span>
            直接修改持久化 XML 配置，等同于 <Text code>virsh edit {name}</Text>。
            保存后立即生效于持久配置；CPU 拓扑、最大内存等底层参数需<strong>关机重启</strong>后生效。
          </span>
        }
      />
      {error && <Alert type="error" message={error} style={{ marginBottom: 12 }} />}
      <Space style={{ marginBottom: 8 }}>
        <Button icon={<ReloadOutlined />} onClick={load} size="small">刷新</Button>
        <Button icon={<SaveOutlined />} type="primary" onClick={save} loading={saving} size="small">保存</Button>
      </Space>
      <textarea
        value={xml}
        onChange={e => setXml(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          minHeight: 600,
          background: 'rgba(0,0,0,0.4)',
          border: '1px solid rgba(0,212,255,0.25)',
          borderRadius: 6,
          color: '#c8f0d4',
          fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace",
          fontSize: 13,
          lineHeight: 1.6,
          padding: 16,
          resize: 'vertical',
          outline: 'none',
        }}
      />
    </div>
  )
}
