import { useState } from 'react'
import { Segmented } from 'antd'
import { InfoCircleOutlined, EditOutlined } from '@ant-design/icons'
import XmlInfoPanel from './XmlInfoPanel'
import XmlEditorPanel from './XmlEditorPanel'

interface Props { name: string }

export default function XmlPanel({ name }: Props) {
  const [mode, setMode] = useState<'info' | 'edit'>('info')

  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <Segmented
          value={mode}
          onChange={v => setMode(v as 'info' | 'edit')}
          options={[
            { label: <span><InfoCircleOutlined style={{ marginRight: 6 }} />详情视图</span>, value: 'info' },
            { label: <span><EditOutlined style={{ marginRight: 6 }} />编辑模式</span>, value: 'edit' },
          ]}
        />
      </div>
      {mode === 'info' ? <XmlInfoPanel name={name} /> : <XmlEditorPanel name={name} />}
    </div>
  )
}
