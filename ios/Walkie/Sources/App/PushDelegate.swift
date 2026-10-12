import UIKit
import UserNotifications

// Push: ask once, hand the APNs token to the bridge, and turn a tapped notification into
// "open that session". The bridge only sends when the app isn't in front of you.
final class PushDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    @MainActor static var bridge: Bridge?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    @MainActor
    static func requestAuthorization() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in await PushDelegate.bridge?.registerDevice(token) }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let info = response.notification.request.content.userInfo
        guard let key = info["key"] as? String,
              let agent = Agent(rawValue: (info["agent"] as? String) ?? String(key.prefix { $0 != ":" })) else { return }
        let cwd = info["cwd"] as? String ?? ""
        await MainActor.run { PushDelegate.bridge?.pendingOpen = SessionRoute(key: key, agent: agent, cwd: cwd) }
    }

    // A push that lands while the app is open would only duplicate what's on screen.
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [] }
}
