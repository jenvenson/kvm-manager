import { useState } from 'react'
import { Form, Input, Button, message } from 'antd'
import { DatabaseOutlined } from '@ant-design/icons'
import { authApi, TOKEN_KEY, TOKEN_EXP_KEY } from '../api/client'

export function isLoggedIn() {
  const token = localStorage.getItem(TOKEN_KEY)
  const exp = Number(localStorage.getItem(TOKEN_EXP_KEY) || 0)
  return !!token && exp * 1000 > Date.now()
}

export function logout() {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(TOKEN_EXP_KEY)
  window.location.reload()
}

export default function LoginPage() {
  const [loading, setLoading] = useState(false)

  const onFinish = async ({ username, password }: { username: string; password: string }) => {
    setLoading(true)
    try {
      const { token, expires_at } = await authApi.login(username, password)
      localStorage.setItem(TOKEN_KEY, token)
      localStorage.setItem(TOKEN_EXP_KEY, String(expires_at))
      window.location.reload()
    } catch {
      message.error('账号或密码错误')
      setLoading(false)
    }
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        width: 360, padding: 40,
        background: '#131d2e',
        border: '1px solid rgba(0,212,255,0.2)',
        borderRadius: 10,
      }}>
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <DatabaseOutlined style={{ fontSize: 32, color: 'var(--color-cyan)', marginBottom: 12 }} />
          <div style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-cyan)', fontWeight: 700, fontSize: 18, letterSpacing: 2 }}>
            KVM MATRIX
          </div>
          <div style={{ color: 'var(--color-text-dim)', fontSize: 13, marginTop: 4 }}>虚拟化管理平台</div>
        </div>
        <Form onFinish={onFinish} layout="vertical" requiredMark={false}>
          <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, marginTop: 8 }}>
            <Button type="primary" htmlType="submit" block loading={loading}>登录</Button>
          </Form.Item>
        </Form>
      </div>
    </div>
  )
}
