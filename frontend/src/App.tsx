import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu, Button } from 'antd'
import {
  DashboardOutlined, HistoryOutlined, CopyOutlined,
  DatabaseOutlined, BarChartOutlined, LogoutOutlined,
} from '@ant-design/icons'
import Dashboard from './pages/Dashboard'
import VMDetail from './pages/VMDetail'
import EventLogPage from './pages/EventLogPage'
import TemplatesPage from './pages/TemplatesPage'
import OverviewPage from './pages/OverviewPage'
import LoginPage, { isLoggedIn, logout } from './pages/LoginPage'

const { Sider, Content } = Layout

const NAV_ITEMS = [
  { key: '/', icon: <BarChartOutlined />, label: '监控总览' },
  { key: '/vms', icon: <DashboardOutlined />, label: '虚拟机列表' },
  { key: '/events', icon: <HistoryOutlined />, label: '事件日志' },
  { key: '/templates', icon: <CopyOutlined />, label: '模板管理' },
]

function SideNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const selectedKey = pathname.startsWith('/vm/') ? '/vms'
    : NAV_ITEMS.find(i => i.key !== '/' && pathname.startsWith(i.key))?.key
    ?? '/'

  return (
    <Sider width={220} className="cyber-sider" style={{ position: 'fixed', height: '100vh', left: 0, top: 0, zIndex: 100 }}>
      <div className="logo-area">
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-cyan)', fontWeight: 700, fontSize: 14, letterSpacing: 2 }}>
          <DatabaseOutlined style={{ marginRight: 8 }} />
          KVM MATRIX
        </span>
      </div>
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={[selectedKey]}
        items={NAV_ITEMS}
        onClick={({ key }) => navigate(key)}
        style={{ marginTop: 8 }}
      />
      <div style={{ position: 'absolute', bottom: 16, left: 0, right: 0, padding: '0 16px' }}>
        <Button
          icon={<LogoutOutlined />}
          size="small"
          block
          onClick={logout}
          style={{ color: 'var(--color-text-dim)', borderColor: 'rgba(255,255,255,0.1)' }}
        >退出登录</Button>
      </div>
    </Sider>
  )
}

function AppLayout() {
  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <SideNav />
      <Layout style={{ marginLeft: 220, background: 'var(--bg-primary)' }}>
        <Content style={{ padding: 24 }}>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/vms" element={<Dashboard />} />
            <Route path="/vm/:name" element={<VMDetail />} />
            <Route path="/events" element={<EventLogPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  )
}

export default function App() {
  if (!isLoggedIn()) return (
    <BrowserRouter basename="/kvm">
      <LoginPage />
    </BrowserRouter>
  )
  return (
    <BrowserRouter basename="/kvm">
      <AppLayout />
    </BrowserRouter>
  )
}
