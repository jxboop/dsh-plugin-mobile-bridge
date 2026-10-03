/**
 * Which local IPv4 address a phone should open, best candidate first.
 *
 * The cable case is the reason this is not a one-liner. When the machine sits on
 * a network that isolates clients (a campus WLAN), the only route a phone has is
 * a USB link — and that link does NOT look like a normal LAN:
 *
 *   iPhone  USB tethering : 172.20.10.2/28, adapter "Apple Mobile Device Ethernet"
 *   Android USB tethering : 192.168.42.x/24, adapter "Remote NDIS based ..."
 *
 * Ranking by private-range prefix alone therefore puts the one address that
 * works last. Two signals are used instead: an adapter name that names the
 * phone, and a prefix short enough to be point-to-point.
 *
 * Kept free of `node:os` so it can be exercised with a literal interface map.
 */

/**
 * Adapter names Windows uses for a link that goes straight to the phone:
 * a USB tether, a Bluetooth personal-area network, or a hotspot.
 *
 * The Bluetooth entry matters for iPhone specifically: Apple's USB tethering
 * needs Apple's driver installed, while the Bluetooth PAN adapter ("蓝牙网络连接"
 * / "Bluetooth Network Connection") is present on a machine that never had it.
 */
const DIRECT_HINT = /apple|iphone|ipad|mobile device|rndis|remote ndis|usb|android|tether|hotspot|bluetooth|蓝牙|personal area network/i

/** A /28 link (16 addresses) is a cable or a hotspot, never a campus LAN. */
const POINT_TO_POINT_PREFIX = 28

/**
 * @param {string} name  adapter name as reported by the OS
 * @param {string} cidr  e.g. "172.20.10.2/28"
 * @returns {{prefix: number, direct: boolean}}
 */
export function classifyInterface(name, cidr) {
	const slash = typeof cidr === 'string' ? cidr.lastIndexOf('/') : -1
	const raw = slash >= 0 ? Number(cidr.slice(slash + 1)) : Number.NaN
	const prefix = Number.isInteger(raw) && raw >= 0 && raw <= 32 ? raw : 24
	return {
		prefix,
		direct: DIRECT_HINT.test(String(name)) || prefix >= POINT_TO_POINT_PREFIX,
	}
}

/**
 * 0 is best. A remembered address always wins: it is the one a phone actually
 * reached us on, which beats any guess about which adapter is the cable.
 */
function weight(entry, preferred) {
	if (preferred !== '' && entry.address === preferred) return 0
	if (entry.direct === true) return 1
	if (entry.address.startsWith('192.168.')) return 2
	if (entry.address.startsWith('100.')) return 3
	if (entry.address.startsWith('10.')) return 4
	if (entry.address.startsWith('172.')) return 5
	return 6
}

/**
 * @param {Record<string, Array<object>>} interfaces  e.g. `os.networkInterfaces()`
 * @param {string} preferred  address a phone has already reached us on, if any
 */
export function collectAddresses(interfaces, preferred = '') {
	const found = []
	for (const [name, entries] of Object.entries(interfaces ?? {})) {
		for (const entry of entries ?? []) {
			if (entry === null || typeof entry !== 'object') continue
			if (entry.family !== 'IPv4' || entry.internal === true) continue
			const address = String(entry.address ?? '')
			if (address === '' || address.startsWith('169.254.')) continue
			const { prefix, direct } = classifyInterface(name, entry.cidr)
			found.push({
				address,
				interface: name,
				cidr: typeof entry.cidr === 'string' ? entry.cidr : `${address}/${prefix}`,
				direct,
				learned: preferred !== '' && address === preferred,
			})
		}
	}
	found.sort((left, right) => weight(left, preferred) - weight(right, preferred))
	return found
}

/** `http://host:port/` plus a short label for why this one is first. */
export function describeAddress(entry, port) {
	const label = entry.learned === true
		? '上次手机连上的'
		: entry.direct === true
			? 'USB / 直连'
			: entry.interface
	return { url: `http://${entry.address}:${port}/`, label }
}
