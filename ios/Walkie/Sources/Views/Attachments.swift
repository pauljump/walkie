import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// Attachments (specs/ready/muse-foundations.md): photos and files go to the Mac first
// (`POST /api/upload`), then the message carries their paths so any agent can open them:
//
//     <your text>
//
//     Attached:
//     - /Users/…/.walkie/uploads/<conversation>/<time>-receipt.jpg

struct Attachment: Identifiable, Hashable {
    let id = UUID()
    let name: String
    let path: String
    let type: String
    var thumbnail: Data?
    var isImage: Bool { type.hasPrefix("image/") }
}

enum AttachmentText {
    static let marker = "Attached:"

    /// The message with its attachment list appended.
    static func join(_ text: String, _ items: [Attachment]) -> String {
        guard !items.isEmpty else { return text }
        let list = items.map { "- \($0.path)" }.joined(separator: "\n")
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return body.isEmpty ? "\(marker)\n\(list)" : "\(body)\n\n\(marker)\n\(list)"
    }

    /// Split a sent message back into what you wrote and the attached paths.
    static func split(_ text: String) -> (body: String, paths: [String]) {
        guard let range = text.range(of: "\n\(marker)\n") ?? (text.hasPrefix("\(marker)\n") ? text.range(of: "\(marker)\n") : nil) else { return (text, []) }
        let paths = text[range.upperBound...].split(separator: "\n").compactMap { line -> String? in
            let t = line.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("- /") ? String(t.dropFirst(2)) : nil
        }
        guard !paths.isEmpty else { return (text, []) }
        return (String(text[..<range.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines), paths)
    }

    static func isImage(_ path: String) -> Bool { ["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"].contains((path as NSString).pathExtension.lowercased()) }
}

extension Bridge {
    /// Send a file to the Mac; returns where it was saved.
    func upload(_ data: Data, name: String, type: String, conversation: String?) async throws -> Attachment {
        guard let base = connection.httpBase else { throw BridgeError.notConfigured }
        var req = URLRequest(url: base.appendingPathComponent("api/upload"))
        req.httpMethod = "POST"
        req.setValue(connection.key, forHTTPHeaderField: "x-api-key")
        req.setValue(type, forHTTPHeaderField: "content-type")
        req.setValue(name, forHTTPHeaderField: "x-walkie-filename")
        req.setValue(conversation ?? "new", forHTTPHeaderField: "x-walkie-conversation")
        let (body, response) = try await URLSession.shared.upload(for: req, from: data)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        struct R: Decodable { let path: String; let name: String; let type: String; let error: String? }
        guard (200..<300).contains(code), let r = try? JSONDecoder().decode(R.self, from: body) else {
            let msg = (try? JSONSerialization.jsonObject(with: body) as? [String: Any])?["error"] as? String
            throw BridgeError.http(code, msg ?? "Upload failed (\(code))")
        }
        return Attachment(name: r.name, path: r.path, type: r.type, thumbnail: type.hasPrefix("image/") ? data : nil)
    }

    /// An uploaded file's bytes (for thumbnails of sent messages).
    func uploadData(_ path: String) async throws -> Data {
        guard let base = connection.httpBase, var comps = URLComponents(url: base.appendingPathComponent("api/upload"), resolvingAgainstBaseURL: false) else { throw BridgeError.notConfigured }
        comps.queryItems = [URLQueryItem(name: "path", value: path)]
        var req = URLRequest(url: comps.url!)
        req.setValue(connection.key, forHTTPHeaderField: "x-api-key")
        let (data, _) = try await URLSession.shared.data(for: req)
        return data
    }
}

/// The paperclip: photos from the library, or any file. Uploads right away and adds a chip.
struct AttachButton: View {
    @Binding var items: [Attachment]
    let conversation: String?
    @Environment(Bridge.self) private var bridge
    @State private var photos: [PhotosPickerItem] = []
    @State private var pickingPhotos = false
    @State private var pickingFile = false
    @State private var uploading = 0
    @State private var error: String?

    var body: some View {
        Menu {
            Button { pickingPhotos = true } label: { Label("Photos", systemImage: "photo") }
            Button { pickingFile = true } label: { Label("Files", systemImage: "doc") }
        } label: {
            Group {
                if uploading > 0 { ProgressView().controlSize(.small) }
                else { Image(systemName: "paperclip").font(.title3).foregroundStyle(WK.textSecondary) }
            }
            .frame(width: 28, height: 30)
        }
        .accessibilityLabel("Attach")
        .photosPicker(isPresented: $pickingPhotos, selection: $photos, maxSelectionCount: 6, matching: .images)
        .fileImporter(isPresented: $pickingFile, allowedContentTypes: [.image, .pdf, .plainText, .commaSeparatedText, .json, UTType(filenameExtension: "md") ?? .plainText], allowsMultipleSelection: true) { result in
            guard case .success(let urls) = result else { return }
            for url in urls {
                guard url.startAccessingSecurityScopedResource() else { continue }
                defer { url.stopAccessingSecurityScopedResource() }
                if let data = try? Data(contentsOf: url) {
                    let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "text/plain"
                    send(data, name: url.lastPathComponent, type: type)
                }
            }
        }
        .onChange(of: photos) { _, picked in
            let batch = picked; photos = []
            for item in batch {
                Task {
                    guard let data = try? await item.loadTransferable(type: Data.self) else { return }
                    let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.85) ?? data
                    send(jpeg, name: "photo-\(Int(Date().timeIntervalSince1970)).jpg", type: "image/jpeg")
                }
            }
        }
        .alert("Couldn't attach", isPresented: Binding(get: { error != nil }, set: { if !$0 { error = nil } })) { Button("OK", role: .cancel) {} } message: { Text(error ?? "") }
    }

    private func send(_ data: Data, name: String, type: String) {
        uploading += 1
        Task {
            defer { uploading -= 1 }
            do { items.append(try await bridge.upload(data, name: name, type: type, conversation: conversation)) }
            catch { self.error = error.localizedDescription }
        }
    }
}

/// Chips for what's attached to the message you're writing.
struct AttachmentTray: View {
    @Binding var items: [Attachment]
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(items) { a in
                    HStack(spacing: 6) {
                        if let d = a.thumbnail, let img = UIImage(data: d) {
                            Image(uiImage: img).resizable().scaledToFill().frame(width: 34, height: 34).clipShape(RoundedRectangle(cornerRadius: 6))
                        } else {
                            Image(systemName: "doc").frame(width: 34, height: 34).background(WK.surfaceHi, in: RoundedRectangle(cornerRadius: 6))
                        }
                        Text(a.name).font(.caption).lineLimit(1).frame(maxWidth: 110)
                        Button { items.removeAll { $0.id == a.id } } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(WK.textTertiary) }
                            .accessibilityLabel("Remove \(a.name)")
                    }
                    .padding(4).padding(.trailing, 4)
                    .background(WK.surface, in: RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(.horizontal, 10)
        }
        .padding(.top, 6)
    }
}

/// Attached files under a sent message: image thumbnails, a file chip otherwise.
struct SentAttachments: View {
    let paths: [String]
    @Environment(Bridge.self) private var bridge
    @State private var images: [String: UIImage] = [:]

    var body: some View {
        HStack(spacing: 6) {
            Spacer(minLength: 40)
            ForEach(paths, id: \.self) { p in
                if AttachmentText.isImage(p) {
                    Group {
                        if let img = images[p] { Image(uiImage: img).resizable().scaledToFill() }
                        else { WK.surfaceHi }
                    }
                    .frame(width: 84, height: 84).clipShape(RoundedRectangle(cornerRadius: 12))
                    .task { if images[p] == nil, let d = try? await bridge.uploadData(p) { images[p] = UIImage(data: d) } }
                } else {
                    Label((p as NSString).lastPathComponent.replacingOccurrences(of: #"^\d+-"#, with: "", options: .regularExpression), systemImage: "doc")
                        .font(.caption).padding(.horizontal, 10).padding(.vertical, 6)
                        .background(WK.surfaceHi, in: Capsule())
                }
            }
        }
    }
}
