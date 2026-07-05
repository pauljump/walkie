import Foundation
import Network
import Combine

// Finds your Mac on the same wifi so you don't type its address. Your Mac's installer
// advertises a Bonjour service named `_walkie._tcp`; this
// class is the phone side that listens for it.
//
// The whole browser lives behind this one type so the feature is one file: the view holds
// a @StateObject of it, calls start() while the picker is on screen, and reads `phase` +
// `macs`.
//
// Two iOS gotchas are load-bearing here, and both used to leave the user staring at a
// spinner with no idea what was wrong:
//  • Info.plist MUST list `_walkie._tcp` under NSBonjourServices or NWBrowser sees nothing,
//    with no error. (The plist edit is not optional.)
//  • The first browse triggers the "allow Walkie to find devices on your wifi" prompt. If
//    the user taps "Don't Allow", results just stay empty forever and no error fires.
//
// So instead of one "isBrowsing" bool this exposes a `phase` the view can turn into a plain
// sentence: asking for permission, searching, found something, found nothing after a while,
// or permission was turned down. No state is a dead end — every one has a next step.
@MainActor
final class LANDiscovery: ObservableObject {

    struct FoundMac: Identifiable, Equatable {
        let id: String            // the Bonjour instance name (stable per Mac)
        let displayName: String   // human name with the service suffix stripped
        let endpoint: NWEndpoint
        static func == (a: FoundMac, b: FoundMac) -> Bool { a.id == b.id }
    }

    // The one thing the view reads to decide what to say. Each case maps to a plain-language
    // message + a next step in PickMacView.
    enum Phase: Equatable {
        case asking       // browser starting up; the wifi-permission prompt is (or is about to be) on screen
        case searching    // permission granted, actively looking, nothing found yet
        case found        // at least one Mac is on the list
        case empty        // searched past the timeout with nothing found (Mac off? not on this wifi?)
        case denied       // the wifi permission was turned down — needs Settings
    }

    @Published private(set) var macs: [FoundMac] = []
    @Published private(set) var phase: Phase = .asking

    private var browser: NWBrowser?
    // Fires once the search has run a while with nothing found, so the view can stop spinning
    // and explain instead. ~9s: long enough for a healthy Mac to show up on the same wifi,
    // short enough that a user isn't left waiting.
    private var timeoutTask: Task<Void, Never>?
    private let searchTimeout: Duration = .seconds(9)

    func start() {
        guard browser == nil else { return }
        macs = []
        phase = .asking

        let params = NWParameters()
        params.includePeerToPeer = true
        let descriptor = NWBrowser.Descriptor.bonjour(type: "_walkie._tcp", domain: nil)
        let b = NWBrowser(for: descriptor, using: params)

        b.stateUpdateHandler = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                switch state {
                case .ready:
                    // Permission granted (or already granted) and the browse is live. If we
                    // haven't found anything yet, we're searching; the timeout will move us to
                    // .empty if nothing turns up.
                    if self.macs.isEmpty { self.phase = .searching }
                    self.armTimeout()
                case .waiting(let error):
                    // iOS parks the browser in .waiting when Local Network access is denied
                    // (the browse can't proceed). Treat a wifi-permission error here as denied
                    // so the view can point the user straight at Settings instead of spinning.
                    if Self.isPermissionError(error) {
                        self.phase = .denied
                        self.timeoutTask?.cancel()
                    }
                case .failed(let error):
                    // A failed browser after being asked is the other "Local Network denied"
                    // signature on iOS. If it looks like a permission error, say so exactly;
                    // otherwise fall back to the plain "found nothing" explanation.
                    self.timeoutTask?.cancel()
                    self.phase = Self.isPermissionError(error) ? .denied : .empty
                case .cancelled:
                    self.timeoutTask?.cancel()
                default:
                    break
                }
            }
        }

        b.browseResultsChangedHandler = { [weak self] results, _ in
            Task { @MainActor in
                guard let self else { return }
                self.macs = results.compactMap { LANDiscovery.map($0) }
                if !self.macs.isEmpty {
                    self.phase = .found
                    self.timeoutTask?.cancel()
                } else if self.phase == .found {
                    // The last Mac dropped off the wifi; go back to searching (not a dead end).
                    self.phase = .searching
                    self.armTimeout()
                }
            }
        }

        browser = b
        b.start(queue: .main)
    }

    func stop() {
        timeoutTask?.cancel()
        timeoutTask = nil
        browser?.cancel()
        browser = nil
        macs = []
        phase = .asking
    }

    // Let the user re-run the search from the empty/denied screens without leaving the picker.
    func retry() {
        stop()
        start()
    }

    // After the browser goes ready, give a healthy Mac a fair window to appear. If none does,
    // move to .empty so the view stops spinning and explains the likely reasons. Cancelled the
    // moment a result arrives or the phase changes to found/denied.
    private func armTimeout() {
        timeoutTask?.cancel()
        timeoutTask = Task { [weak self] in
            try? await Task.sleep(for: self?.searchTimeout ?? .seconds(9))
            guard let self, !Task.isCancelled else { return }
            if self.macs.isEmpty, self.phase == .searching {
                self.phase = .empty
            }
        }
    }

    // Best-effort: does this NWError look like the Local Network permission being denied?
    // iOS doesn't hand us a clean "permission denied" code, but the POSIX EPERM / "denied"
    // shapes are the observed signature. Kept conservative — when unsure we fall back to the
    // gentler "found nothing" message rather than wrongly accusing the user of denying access.
    private nonisolated static func isPermissionError(_ error: NWError) -> Bool {
        switch error {
        case .posix(let code):
            return code == .EPERM || code == .EACCES
        default:
            return false
        }
    }

    // Turn a browse result into a FoundMac. Only Bonjour-service endpoints carry a legible
    // name; anything else is skipped.
    private static func map(_ result: NWBrowser.Result) -> FoundMac? {
        guard case let .service(name, _, _, _) = result.endpoint else { return nil }
        let display = name
            .replacingOccurrences(of: "._walkie._tcp.", with: "")
            .replacingOccurrences(of: "._walkie._tcp", with: "")
        return FoundMac(id: name, displayName: display.isEmpty ? name : display, endpoint: result.endpoint)
    }

    // Resolve a picked Mac to a reachable host + port. Bonjour does NOT carry the secret
    // key (it would broadcast it on the wifi in the clear), so this fills host+port only and
    // the UI still asks the user to paste the short key once. The QR path is the
    // no-typing-at-all route. Returns nil if resolution times out.
    func resolve(_ mac: FoundMac) async -> PairingPayload? {
        await withCheckedContinuation { (continuation: CheckedContinuation<PairingPayload?, Never>) in
            let conn = NWConnection(to: mac.endpoint, using: .tcp)
            var finished = false
            let finish: (PairingPayload?) -> Void = { payload in
                guard !finished else { return }
                finished = true
                conn.cancel()
                continuation.resume(returning: payload)
            }

            conn.stateUpdateHandler = { state in
                switch state {
                case .ready:
                    if let ep = conn.currentPath?.remoteEndpoint,
                       case let .hostPort(host, port) = ep {
                        let hostString = LANDiscovery.hostString(host)
                        finish(PairingPayload(host: hostString, port: Int(port.rawValue), key: ""))
                    } else {
                        finish(nil)
                    }
                case .failed, .cancelled:
                    finish(nil)
                default:
                    break
                }
            }

            conn.start(queue: .main)

            // Don't hang the picker if the Mac never answers.
            DispatchQueue.main.asyncAfter(deadline: .now() + 5) { finish(nil) }
        }
    }

    // Render an NWEndpoint.Host as a dialable string, preferring the resolved name. nonisolated
    // because it's pure (no actor state) and gets called from the NWConnection callback queue.
    private nonisolated static func hostString(_ host: NWEndpoint.Host) -> String {
        switch host {
        case .name(let name, _): return name
        case .ipv4(let addr):    return "\(addr)".components(separatedBy: "%").first ?? "\(addr)"
        case .ipv6(let addr):    return "\(addr)".components(separatedBy: "%").first ?? "\(addr)"
        @unknown default:        return "\(host)"
        }
    }
}
