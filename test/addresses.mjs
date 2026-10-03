/**
 * Address ordering for lib/addresses.js.
 *
 *   node test/addresses.mjs
 *
 * Driven by synthetic interface maps rather than this machine's adapters: the
 * whole point of the ranking is the USB-tethering case, and that only exists
 * while a phone is physically plugged in.
 */

import { classifyInterface, collectAddresses, describeAddress } from '../lib/addresses.js'

const results = []
const check = (name, ok, detail = '') => {
	results.push({ name, ok })
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : `  — ${detail}`}`)
}

/* Shape copied from `os.networkInterfaces()` on Windows. */
const iface = (address, cidr) => [{ address, netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr }]
const loopback = [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }]
const linkLocal = [{ address: '169.254.10.20', netmask: '255.255.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: false, cidr: '169.254.10.20/16' }]

/* --- classification ------------------------------------------------------ */

check('an iPhone tether adapter is recognised by name alone',
	classifyInterface('Apple Mobile Device Ethernet', '172.20.10.2/28').direct === true)
check('an Android RNDIS tether adapter is recognised by name',
	classifyInterface('Remote NDIS based Internet Sharing Device', '192.168.42.100/24').direct === true)
check('a /28 link counts as point-to-point even with a boring name',
	classifyInterface('以太网', '172.20.10.2/28').direct === true)
check('a campus /16 over Wi-Fi is not a direct link',
	classifyInterface('WLAN', '100.64.7.254/16').direct === false,
	JSON.stringify(classifyInterface('WLAN', '100.64.7.254/16')))
check('a Bluetooth PAN adapter counts as a direct link',
	classifyInterface('蓝牙网络连接', '172.20.10.2/24').direct === true)
check('a /24 Bluetooth PAN still counts without the Chinese name',
	classifyInterface('Bluetooth Network Connection', '192.168.1.5/24').direct === true)
check('a missing cidr does not throw', classifyInterface('WLAN', undefined).prefix === 24)

/* --- the ranking that was wrong ------------------------------------------ */

const campusAndCable = {
	WLAN: iface('100.64.7.254', '100.64.7.254/16'),
	'Apple Mobile Device Ethernet': iface('172.20.10.2', '172.20.10.2/28'),
	SSTAP: iface('10.198.75.60', '10.198.75.60/24'),
}
const ranked = collectAddresses(campusAndCable, '')
check('the USB cable address outranks a campus /16 and a proxy adapter',
	ranked[0].address === '172.20.10.2' && ranked[0].direct === true,
	ranked.map((entry) => entry.address).join(' -> '))
check('the campus address is still offered as a fallback',
	ranked.some((entry) => entry.address === '100.64.7.254'))

const android = {
	WLAN: iface('192.168.1.50', '192.168.1.50/24'),
	'Remote NDIS based Internet Sharing Device': iface('192.168.42.100', '192.168.42.100/24'),
}
check('Android USB tethering wins over a home WLAN both on 192.168.x',
	collectAddresses(android, '')[0].address === '192.168.42.100',
	collectAddresses(android, '').map((entry) => entry.address).join(' -> '))

/* --- the remembered address wins ----------------------------------------- */

const remembered = collectAddresses(campusAndCable, '100.64.7.254')
check('an address a phone actually used is promoted above every guess',
	remembered[0].address === '100.64.7.254' && remembered[0].learned === true,
	remembered.map((entry) => `${entry.address}${entry.learned ? '*' : ''}`).join(' -> '))

/* --- exclusions and labels ----------------------------------------------- */

const noisy = { Loopback: loopback, WLAN: iface('100.64.7.254', '100.64.7.254/16'), Stub: linkLocal }
const cleaned = collectAddresses(noisy, '')
check('loopback and 169.254 link-local are excluded',
	cleaned.length === 1 && cleaned[0].address === '100.64.7.254',
	cleaned.map((entry) => entry.address).join(', '))
check('an empty interface map yields an empty list', collectAddresses({}, '').length === 0)

check('a remembered address is labelled as such',
	describeAddress(collectAddresses(campusAndCable, '172.20.10.2')[0], 3081).label === '上次手机连上的')
check('a cable address is labelled USB / 直连',
	describeAddress({ address: '172.20.10.2', interface: 'Apple Mobile Device Ethernet', direct: true }, 3081).label === 'USB / 直连')
check('the url carries the port',
	describeAddress({ address: '172.20.10.2', interface: 'x', direct: true }, 3081).url === 'http://172.20.10.2:3081/')

const failed = results.filter((entry) => !entry.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
