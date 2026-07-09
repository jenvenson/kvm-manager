import axios from 'axios'
import type {
  VMSummary, VMDetail, CPUConfig, MemoryConfig, DiskInfo, USBDevice,
  SnapshotInfo, ConsoleInfo, VMStats, NetworkInterface, HostNetwork,
  ProtectionConfig, Template, EventsResponse, GuestAgentStatus, HostInfo,
  HostUsbDisk, UsbDiskInfo,
} from '../types'

export const TOKEN_KEY = 'kvm_token'
export const TOKEN_EXP_KEY = 'kvm_token_exp'

const api = axios.create({ baseURL: '/kvm/api', timeout: 10000 })

api.interceptors.request.use(config => {
  const token = localStorage.getItem(TOKEN_KEY)
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  r => r,
  err => {
    if (err.response?.status === 401 && err.config?.url !== '/login') {
      localStorage.removeItem(TOKEN_KEY)
      localStorage.removeItem(TOKEN_EXP_KEY)
      window.location.reload()
    }
    return Promise.reject(err)
  },
)

export const authApi = {
  login: (username: string, password: string) =>
    api.post<{ token: string; expires_at: number }>('/login', { username, password })
      .then(r => r.data),
}

export const vmApi = {
  list: () => api.get<VMSummary[]>('/vms').then(r => r.data),
  get: (name: string) => api.get<VMDetail>(`/vms/${name}`).then(r => r.data),
  start: (name: string) => api.post(`/vms/${name}/start`),
  shutdown: (name: string) => api.post(`/vms/${name}/shutdown`),
  forceOff: (name: string) => api.post(`/vms/${name}/force-off`),
  reboot: (name: string) => api.post(`/vms/${name}/reboot`),
  getXml: (name: string) => api.get<{ xml: string }>(`/vms/${name}/xml`).then(r => r.data),
  updateXml: (name: string, xml: string) => api.put(`/vms/${name}/xml`, { xml }),
  getStats: (name: string) => api.get<VMStats>(`/vms/${name}/stats`).then(r => r.data),
  getGuestAgent: (name: string) => api.get<GuestAgentStatus>(`/vms/${name}/guest-agent`).then(r => r.data),
}
export const cpuApi = {
  get: (name: string) => api.get<CPUConfig>(`/vms/${name}/cpu`).then(r => r.data),
  update: (name: string, data: CPUConfig) => api.put(`/vms/${name}/cpu`, data),
}
export const memoryApi = {
  get: (name: string) => api.get<MemoryConfig>(`/vms/${name}/memory`).then(r => r.data),
  update: (name: string, data: Partial<MemoryConfig>) => api.put(`/vms/${name}/memory`, data),
}
export const diskApi = {
  list: (name: string) => api.get<DiskInfo[]>(`/vms/${name}/disks`).then(r => r.data),
  attach: (name: string, data: { path?: string; size_gb?: number }) => api.post(`/vms/${name}/disks`, data),
  detach: (name: string, dev: string) => api.delete(`/vms/${name}/disks/${dev}`),
}
export const usbApi = {
  listHost: () => api.get<USBDevice[]>('/host/usb').then(r => r.data),
  listVm: (name: string) => api.get<USBDevice[]>(`/vms/${name}/usb`).then(r => r.data),
  attach: (name: string, data: { vendor_id: string; product_id: string }) => api.post(`/vms/${name}/usb`, data),
  detach: (name: string, id: string) => api.delete(`/vms/${name}/usb/${id}`),
}
export const usbDiskApi = {
  listHost: () => api.get<HostUsbDisk[]>('/host/usb-disks').then(r => r.data),
  listVm: (name: string) => api.get<UsbDiskInfo[]>(`/vms/${name}/usb-disks`).then(r => r.data),
  attach: (name: string, data: { host_dev: string; persistent: boolean }) =>
    api.post(`/vms/${name}/usb-disks`, data),
  detach: (name: string, dev: string, force = false) =>
    api.delete(`/vms/${name}/usb-disks/${dev}`, { params: { force } }),
}
export const snapshotApi = {
  list: (name: string) => api.get<SnapshotInfo[]>(`/vms/${name}/snapshots`).then(r => r.data),
  create: (name: string, data: { name: string; description?: string }) => api.post(`/vms/${name}/snapshots`, data),
  revert: (name: string, snap: string) => api.post(`/vms/${name}/snapshots/${snap}/revert`),
  delete: (name: string, snap: string) => api.delete(`/vms/${name}/snapshots/${snap}`),
}
export const consoleApi = {
  getUrl: (name: string) => api.get<ConsoleInfo>(`/vms/${name}/console`).then(r => r.data),
}
export const networkApi = {
  listHost: () => api.get<HostNetwork[]>('/host/networks').then(r => r.data),
  listVm: (name: string) => api.get<NetworkInterface[]>(`/vms/${name}/networks`).then(r => r.data),
  attach: (name: string, data: { source: string; source_type?: string; model?: string }) =>
    api.post(`/vms/${name}/networks`, data),
  detach: (name: string, mac: string) => api.delete(`/vms/${name}/networks/${mac}`),
}
export const protectionApi = {
  get: () => api.get<ProtectionConfig>('/config/protection').then(r => r.data),
  set: (vmName: string, level: string, note?: string) =>
    api.put(`/config/protection/${vmName}`, { level, note: note ?? '' }),
  remove: (vmName: string) => api.delete(`/config/protection/${vmName}`),
}
export const templateApi = {
  list: () => api.get<Template[]>('/templates').then(r => r.data),
  create: (data: { vm_name: string; template_name: string; description?: string }) =>
    api.post('/templates', data),
  clone: (templateName: string, newVmName: string) =>
    api.post(`/templates/${templateName}/clone`, { new_vm_name: newVmName }),
  delete: (templateName: string) => api.delete(`/templates/${templateName}`),
}
export const eventsApi = {
  list: (page = 1, vmName = '') =>
    api.get<EventsResponse>('/events', { params: { page, vm_name: vmName } }).then(r => r.data),
}
export const hostApi = {
  info: () => api.get<HostInfo>('/host/info').then(r => r.data),
}
