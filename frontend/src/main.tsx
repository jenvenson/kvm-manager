import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antTheme.darkAlgorithm,
        token: {
          colorPrimary: '#00d4ff',
          colorBgBase: '#0e1525',
          colorBgContainer: '#131d2e',
          colorBgElevated: '#131d2e',
          colorBorder: 'rgba(0, 212, 255, 0.2)',
          colorText: '#ddeeff',
          colorTextSecondary: '#6a85a8',
          borderRadius: 6,
          fontSize: 15,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        },
        components: {
          Layout: { siderBg: '#0a0f1a', bodyBg: '#0e1525', headerBg: '#0e1525' },
          Menu: {
            darkItemBg: 'transparent',
            darkItemSelectedBg: 'rgba(0, 212, 255, 0.08)',
            darkItemSelectedColor: '#00d4ff',
            darkItemHoverBg: 'rgba(0, 212, 255, 0.04)',
          },
          Card: { colorBgContainer: 'rgba(18, 28, 48, 0.95)' },
          Table: { colorBgContainer: 'rgba(18, 28, 48, 0.95)', headerBg: 'rgba(0, 212, 255, 0.05)' },
          Modal: { contentBg: '#131d2e', headerBg: '#131d2e' },
          Drawer: { colorBgElevated: '#131d2e' },
          Tabs: { colorBgContainer: 'transparent' },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
