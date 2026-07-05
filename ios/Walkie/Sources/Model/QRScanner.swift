import Foundation
import AVFoundation
import SwiftUI

// The camera side of pairing. Point the phone at the QR your Mac's installer prints and it
// reads `walkie://pair?host=..&port=..&key=..` in one tap, so nothing is typed. The scan is
// the only path that can fill all three fields (host, port, key) with no typing, because the
// key rides in a QR shown on your own screen, not broadcast on the wifi.
//
// Two facts drive the design:
//  • The Simulator has no camera, so a QR scan can only be tested on a real device. The view
//    must offer the LAN picker and "type it instead" as fallbacks.
//  • Without NSCameraUsageDescription in Info.plist, the first camera access CRASHES (it is
//    not a soft denial). The plist edit is load-bearing. A user "Don't Allow" is a soft
//    `.denied` state this class publishes so the view can show a fallback.
@MainActor
final class QRScanner: NSObject, ObservableObject, AVCaptureMetadataOutputObjectsDelegate {
    enum Access { case unknown, authorized, denied, unavailable }

    @Published private(set) var access: Access = .unknown
    @Published var scanned: String?          // the raw string of the last QR read
    var onFound: ((String) -> Void)?

    let session = AVCaptureSession()
    private let metadataQueue = DispatchQueue(label: "walkie.qr.metadata")
    private var configured = false

    // Ask for camera access (or read the current grant) then wire the session up.
    func start() {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            access = .authorized
            configureAndRun()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
                Task { @MainActor in
                    guard let self else { return }
                    if granted { self.access = .authorized; self.configureAndRun() }
                    else { self.access = .denied }
                }
            }
        case .denied, .restricted:
            access = .denied
        @unknown default:
            access = .denied
        }
    }

    func stop() {
        guard session.isRunning else { return }
        let s = session
        metadataQueue.async { s.stopRunning() }
    }

    private func configureAndRun() {
        if !configured { configure() }
        guard configured else { return }
        let s = session
        metadataQueue.async { if !s.isRunning { s.startRunning() } }
    }

    private func configure() {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            access = .unavailable          // e.g. Simulator: no camera hardware
            return
        }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { access = .unavailable; return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: metadataQueue)
        output.metadataObjectTypes = output.availableMetadataObjectTypes.contains(.qr) ? [.qr] : []

        configured = true
    }

    // MARK: AVCaptureMetadataOutputObjectsDelegate (called off the main actor)
    nonisolated func metadataOutput(_ output: AVCaptureMetadataOutput,
                                    didOutput objects: [AVMetadataObject],
                                    from connection: AVCaptureConnection) {
        guard let obj = objects.first as? AVMetadataMachineReadableCodeObject,
              obj.type == .qr, let value = obj.stringValue else { return }
        Task { @MainActor in
            // First hit wins; stop so we don't fire onFound repeatedly for the same code.
            guard self.scanned == nil else { return }
            self.scanned = value
            self.stop()
            self.onFound?(value)
        }
    }
}

// The live viewfinder. A thin UIView whose layer IS the capture preview, so SwiftUI can drop
// it into OnboardingView / Settings without owning AVFoundation itself.
struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    func makeUIView(context: Context) -> PreviewView {
        let v = PreviewView()
        v.previewLayer.session = session
        v.previewLayer.videoGravity = .resizeAspectFill
        return v
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        uiView.previewLayer.session = session
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }
}
