import { Client } from 'ssh2';

export interface RemoteMetricsSnapshot {
	cpuTotalTicks: number | undefined;
	cpuIdleTicks: number | undefined;
	cpuUsage: number | undefined;
	memoryUsedMb: number | undefined;
	memoryTotalMb: number | undefined;
	diskUsage: number | undefined;
	networkInterface: string | undefined;
	networkRxBytes: number | undefined;
	networkTxBytes: number | undefined;
}

export interface RemoteMetricsDisplay {
	cpu: string;
	memory: string;
	disk: string;
	network: string;
}

interface CpuSample {
	totalTicks: number;
	idleTicks: number;
}

interface NetworkSample {
	timestamp: number;
	rxBytes: number;
	txBytes: number;
	interfaceName: string;
}

const collectRemoteMetricsCommand = String.raw`sh -lc '
if [ -r /proc/stat ]; then
	cpu=$(awk '\''/^cpu / { total = 0; for (i = 2; i <= NF; i++) total += $i; idle = $5; if (NF >= 6) idle += $6; printf "%.0f %.0f", total, idle; exit }'\'' /proc/stat 2>/dev/null)
	mem=$(awk '\''/MemTotal:/ { total = $2 } /MemAvailable:/ { avail = $2 } END { if (total > 0) printf "%.0f %.0f", (total - avail) / 1024, total / 1024 }'\'' /proc/meminfo 2>/dev/null)
	disk=$(df -Pk / 2>/dev/null | awk '\''NR == 2 { gsub("%", "", $5); print $5 }'\'')
	net=$(awk '\''/:/ { gsub(":", "", $1); if ($1 != "lo" && ($2 + $10) > 0) { print $1, $2, $10; exit } }'\'' /proc/net/dev 2>/dev/null)
	set -- $cpu
	cpu_total=$1
	cpu_idle=$2
	set -- $mem
	mem_used=$1
	mem_total=$2
	set -- $net
	net_if=$1
	net_rx=$2
	net_tx=$3
	printf "cpu_total=%s\ncpu_idle=%s\nmem_used=%s\nmem_total=%s\ndisk=%s\nnet_if=%s\nnet_rx=%s\nnet_tx=%s\n" "$cpu_total" "$cpu_idle" "$mem_used" "$mem_total" "$disk" "$net_if" "$net_rx" "$net_tx"
	exit 0
fi

if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then
	cpu=$(LC_ALL=C top -l 2 -n 0 2>/dev/null | awk -F'\''[:,% ]+'\'' '\''/CPU usage/ { value = $4 + $6 } END { print value }'\'')
	page_size=$(pagesize 2>/dev/null)
	mem_total=$(awk '\''BEGIN { printf "%.0f", '\''"$(sysctl -n hw.memsize 2>/dev/null)"'\'' / 1024 / 1024 }'\'')
	free_pages=$(vm_stat 2>/dev/null | awk '\''/Pages free/ { gsub("\\.", "", $3); free = $3 } /Pages inactive/ { gsub("\\.", "", $3); inactive = $3 } /Pages speculative/ { gsub("\\.", "", $3); speculative = $3 } END { print free + inactive + speculative }'\'')
	mem_used=$(awk -v total="$mem_total" -v free="$free_pages" -v page="$page_size" '\''BEGIN { if (total > 0) printf "%.0f", total - ((free * page) / 1024 / 1024) }'\'')
	disk=$(df -Pk / 2>/dev/null | awk '\''NR == 2 { gsub("%", "", $5); print $5 }'\'')
	net_if=$(route -n get default 2>/dev/null | awk '\''/interface:/ { print $2; exit }'\'')
	net=$(netstat -bI "$net_if" 2>/dev/null | awk '\''NR == 2 { print $(NF - 1), $NF; exit }'\'')
	set -- $net
	net_rx=$1
	net_tx=$2
	printf "cpu_total=\ncpu_idle=\ncpu=%s\nmem_used=%s\nmem_total=%s\ndisk=%s\nnet_if=%s\nnet_rx=%s\nnet_tx=%s\n" "$cpu" "$mem_used" "$mem_total" "$disk" "$net_if" "$net_rx" "$net_tx"
	exit 0
fi

printf "cpu_total=\ncpu_idle=\ncpu=\nmem_used=\nmem_total=\ndisk=\nnet_if=\nnet_rx=\nnet_tx=\n"
'`;

export class RemoteMetricsReader {
	async read(client: Client): Promise<RemoteMetricsSnapshot> {
		const output = await executeRemoteCommand(client, collectRemoteMetricsCommand);
		return parseMetricsOutput(output);
	}
}

export class RemoteMetricsFormatter {
	private previousCpuSample: CpuSample | undefined;
	private previousNetworkSample: NetworkSample | undefined;

	format(metrics: RemoteMetricsSnapshot): RemoteMetricsDisplay {
		return {
			cpu: this.formatCpuUsage(metrics),
			memory: formatMemoryUsage(metrics.memoryUsedMb, metrics.memoryTotalMb),
			disk: formatPercent(metrics.diskUsage),
			network: this.formatNetworkThroughput(metrics),
		};
	}

	reset(): void {
		this.previousCpuSample = undefined;
		this.previousNetworkSample = undefined;
	}

	private formatCpuUsage(metrics: RemoteMetricsSnapshot): string {
		if (metrics.cpuTotalTicks === undefined || metrics.cpuIdleTicks === undefined) {
			return formatPercent(metrics.cpuUsage);
		}

		const currentSample: CpuSample = {
			totalTicks: metrics.cpuTotalTicks,
			idleTicks: metrics.cpuIdleTicks,
		};
		const previousSample = this.previousCpuSample;
		this.previousCpuSample = currentSample;
		if (!previousSample) {
			return '--';
		}

		const totalDelta = currentSample.totalTicks - previousSample.totalTicks;
		const idleDelta = currentSample.idleTicks - previousSample.idleTicks;
		if (totalDelta <= 0) {
			return '--';
		}

		return formatPercent(clampPercent(100 * (1 - idleDelta / totalDelta)));
	}

	private formatNetworkThroughput(metrics: RemoteMetricsSnapshot): string {
		if (!metrics.networkInterface || metrics.networkRxBytes === undefined || metrics.networkTxBytes === undefined) {
			return '--';
		}

		const currentSample: NetworkSample = {
			interfaceName: metrics.networkInterface,
			rxBytes: metrics.networkRxBytes,
			txBytes: metrics.networkTxBytes,
			timestamp: Date.now(),
		};
		const previousSample = this.previousNetworkSample;
		this.previousNetworkSample = currentSample;
		if (!previousSample || previousSample.interfaceName !== currentSample.interfaceName) {
			return '--';
		}

		const elapsedSeconds = (currentSample.timestamp - previousSample.timestamp) / 1000;
		if (elapsedSeconds <= 0) {
			return '--';
		}

		const downloadRate = Math.max(0, currentSample.rxBytes - previousSample.rxBytes) / elapsedSeconds;
		const uploadRate = Math.max(0, currentSample.txBytes - previousSample.txBytes) / elapsedSeconds;
		return `${formatByteRate(downloadRate)}↓ ${formatByteRate(uploadRate)}↑`;
	}
}

function parseMetricsOutput(output: string): RemoteMetricsSnapshot {
	const values = new Map<string, string>();
	for (const line of output.split(/\r?\n/u)) {
		const separatorIndex = line.indexOf('=');
		if (separatorIndex > 0) {
			values.set(line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim());
		}
	}

	return {
		cpuTotalTicks: parseNumber(values.get('cpu_total')),
		cpuIdleTicks: parseNumber(values.get('cpu_idle')),
		cpuUsage: parseNumber(values.get('cpu')),
		memoryUsedMb: parseNumber(values.get('mem_used')),
		memoryTotalMb: parseNumber(values.get('mem_total')),
		diskUsage: parseNumber(values.get('disk')),
		networkInterface: values.get('net_if') || undefined,
		networkRxBytes: parseNumber(values.get('net_rx')),
		networkTxBytes: parseNumber(values.get('net_tx')),
	};
}

function executeRemoteCommand(client: Client, command: string): Promise<string> {
	return new Promise((resolve, reject) => {
		client.exec(command, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}

			let stdout = '';
			let stderr = '';
			stream.on('data', (data: Buffer) => stdout += data.toString());
			stream.stderr.on('data', (data: Buffer) => stderr += data.toString());
			stream.on('close', (code: number | undefined) => {
				if (code && code !== 0) {
					reject(new Error(stderr.trim() || `Remote metrics command exited with code ${code}.`));
					return;
				}
				resolve(stdout);
			});
		});
	});
}

function parseNumber(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : undefined;
}

function formatPercent(value: number | undefined): string {
	return value === undefined ? '--' : `${value.toFixed(1)}%`;
}

function formatMemoryUsage(usedMb: number | undefined, totalMb: number | undefined): string {
	if (usedMb === undefined || totalMb === undefined || totalMb <= 0) {
		return '--';
	}
	return `${formatMegabytes(usedMb)}/${formatMegabytes(totalMb)}`;
}

function formatMegabytes(value: number): string {
	return value >= 1024 ? `${(value / 1024).toFixed(1)}GB` : `${Math.round(value)}MB`;
}

function formatByteRate(bytesPerSecond: number): string {
	if (!Number.isFinite(bytesPerSecond) || bytesPerSecond < 0) {
		return '--';
	}
	if (bytesPerSecond >= 1024 * 1024) {
		return `${(bytesPerSecond / 1024 / 1024).toFixed(1)}MB/s`;
	}
	if (bytesPerSecond >= 1024) {
		return `${(bytesPerSecond / 1024).toFixed(1)}KB/s`;
	}
	return `${bytesPerSecond.toFixed(0)}B/s`;
}

function clampPercent(value: number): number {
	return Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 0;
}
