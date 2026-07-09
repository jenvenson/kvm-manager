export interface VMSummary {
  name: string; state: string; vcpus: number; memory_mb: number
}
export interface VMDetail extends VMSummary {
  uuid: string; autostart: boolean
}
export interface CPUConfig {
  vcpus: number; sockets: number; cores: number; threads: number
}
export interface MemoryConfig { current_mb: number; max_mb: number }
export interface DiskInfo { dev: string; path: string; size_gb: number; format: string }
export interface USBDevice { id: string; vendor_id: string; product_id: string; name: string }
export interface HostUsbDisk { dev: string; name: string; size_gb: number; in_use: boolean; used_by: string }
export interface UsbDiskInfo { dev: string; host_dev: string; name: string; size_gb: number; status: 'online' | 'offline' }
export interface SnapshotInfo { name: string; description: string; created_at: string; state: string }
export interface ConsoleInfo { url: string; token: string }

export interface VMStats {
  cpu_percent: number
  mem_percent: number
  mem_used_mb: number
  mem_total_mb: number
  net_rx_bytes: number
  net_tx_bytes: number
  interfaces: { dev: string; mac: string; rx_bytes: number; tx_bytes: number }[]
}
export interface NetworkInterface {
  mac: string; type: string; source: string; model: string; target: string
}
export interface HostNetwork {
  name: string; active: boolean; bridge: string; forward_mode: string
}
export interface ProtectionConfig {
  [vmName: string]: { level: string; note: string }
}
export interface Template {
  name: string; description: string; source_vm: string; created_at: string; size_gb: number
}
export interface HostInfo {
  host_cpus: number
  host_memory_mb: number
  host_memory_free_mb: number
}
export interface GuestAgentStatus {
  status: 'online' | 'booting' | 'no_agent' | 'offline'
  os_name?: string
  kernel?: string
  hostname?: string
  ips?: { iface: string; ip: string; type: string }[]
}
export interface EventLog {
  timestamp: string; method: string; path: string; vm_name: string
  action: string; status_code: number; success: boolean
}
export interface EventsResponse {
  total: number; page: number; page_size: number; items: EventLog[]
}
