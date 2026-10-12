import Foundation
import Observation
import StoreKit

// Money (docs/PRODUCT.md). Walkie is free for one subscription: the first CLI you send a message on.
// "Walkie for all subscriptions" is one non-consumable purchase that opens every CLI, continuing a
// conversation on another plan, and sending a plan to projects across plans.
//
// Reliability over revenue: if the store has never answered on this device (no cached price) and
// nothing is cached as bought, Walkie is unlocked. A StoreKit outage, or the product not existing
// yet, never locks anyone out of their own Mac. Once a price has been seen, the gate holds offline.
@MainActor
@Observable
final class Store {
    static let shared = Store()
    static let productID = "cc.walkie.all"

    private(set) var product: Product?
    private(set) var purchased: Bool
    private(set) var busy = false
    private(set) var lastError: String?
    /// The one CLI the free tier uses: the first you send on. Changeable in Settings until you buy.
    var freeHarness: Agent? {
        didSet { UserDefaults.standard.set(freeHarness?.rawValue, forKey: Keys.free) }
    }
    @ObservationIgnored private var seenPrice: Bool
    @ObservationIgnored private var updates: Task<Void, Never>?

    private enum Keys { static let bought = "wk.store.bought"; static let seen = "wk.store.seenPrice"; static let free = "wk.store.freeHarness" }

    init() {
        purchased = UserDefaults.standard.bool(forKey: Keys.bought)
        seenPrice = UserDefaults.standard.bool(forKey: Keys.seen)
        freeHarness = UserDefaults.standard.string(forKey: Keys.free).flatMap(Agent.init(rawValue:))
    }

    /// Everything open: bought, a debug build, or the store has never been reachable from this device.
    var unlocked: Bool {
        #if DEBUG
        if !UserDefaults.standard.bool(forKey: "walkieGate") { return true } // `-walkieGate YES` tests the gate in Debug
        #endif
        return purchased || !seenPrice
    }

    /// May this CLI take a message right now?
    func allows(_ agent: Agent) -> Bool { unlocked || freeHarness == nil || freeHarness == agent }

    /// The first CLI you send on becomes the free one.
    func claim(_ agent: Agent) { if freeHarness == nil { freeHarness = agent } }

    var priceLabel: String { product?.displayPrice ?? "$29.99" }

    func start() {
        updates?.cancel()
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self, case .verified(let t) = result else { continue }
                if t.productID == Self.productID { await self.setPurchased(t.revocationDate == nil) }
                await t.finish()
            }
        }
        Task { await refresh() }
    }

    func refresh() async {
        do {
            if let p = try await Product.products(for: [Self.productID]).first {
                product = p
                seenPrice = true
                UserDefaults.standard.set(true, forKey: Keys.seen)
            }
        } catch { lastError = error.localizedDescription }
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, t.productID == Self.productID { setPurchased(t.revocationDate == nil) }
        }
    }

    func buy() async {
        guard let product else { lastError = "The store didn't answer. Try again in a moment."; return }
        busy = true; defer { busy = false }
        lastError = nil
        do {
            switch try await product.purchase() {
            case .success(let v):
                if case .verified(let t) = v { setPurchased(true); await t.finish() }
                else { lastError = "Apple couldn't verify that purchase." }
            case .userCancelled, .pending: break
            @unknown default: break
            }
        } catch { lastError = error.localizedDescription }
    }

    func restore() async {
        busy = true; defer { busy = false }
        lastError = nil
        do { try await AppStore.sync() } catch { lastError = error.localizedDescription }
        await refresh()
        if !purchased { lastError = "No purchase found for this Apple Account." }
    }

    private func setPurchased(_ on: Bool) {
        purchased = on
        UserDefaults.standard.set(on, forKey: Keys.bought)
    }
}
