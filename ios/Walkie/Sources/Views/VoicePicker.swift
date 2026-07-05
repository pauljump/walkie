import SwiftUI

// One clear voice picker. The old .segmented control put Robot / BYO / Premium as three
// equal-weight segments with no strong "this one is selected and working" state, so a locked
// Premium looked just like a live choice. This replaces it with a vertical list of rows where
// exactly one row is obviously selected (amber border + a filled check) and the locked row
// wears a lock and a muted style, so "selected" and "locked" can never be confused.
//
// Owns the voice-related UI: the rows, the BYO key field, the sample button (with the audio
// fix), and the honest "Get a voice key" link. SettingsView just drops this in.
struct VoicePicker: View {
    @ObservedObject var settings: AppSettings
    @Environment(\.openURL) private var openURL

    // Local buffer for the BYO key so typing doesn't thrash persistence on every keystroke.
    @State private var voiceKey: String
    // Held for the view's lifetime so the sample speaker isn't deallocated mid-utterance.
    @State private var previewSpeaker: Speaker?
    @State private var sampleNote: String?

    init(settings: AppSettings) {
        self.settings = settings
        _voiceKey = State(initialValue: settings.voiceApiKey)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(SpeakerMode.allCases) { mode in
                row(mode)
            }

            if settings.voiceMode == .byoVoice { byoDetail }

            playSampleButton

            if let sampleNote {
                Text(sampleNote)
                    .font(.wkBody(11))
                    .foregroundStyle(WK.textTertiary)
            }

            getKeyLink
        }
    }

    // MARK: - Rows

    @ViewBuilder
    private func row(_ mode: SpeakerMode) -> some View {
        let selected = settings.voiceMode == mode
        Button {
            // Locked modes can be "selected" for preview intent, but the lock is always shown;
            // VoiceSession degrades a locked mode to the robot voice on the live call.
            settings.voiceMode = mode
            sampleNote = nil
        } label: {
            HStack(alignment: .top, spacing: 12) {
                // The single obvious selection glyph.
                Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 20))
                    .foregroundStyle(selected ? WK.signal : WK.textTertiary)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(mode.title)
                            .font(.wkBody(15, .semibold))
                            .foregroundStyle(mode.isLocked ? WK.locked : WK.textPrimary)
                        if mode.isLocked {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 11))
                                .foregroundStyle(WK.locked)
                        }
                    }
                    Text(mode.blurb)
                        .font(.wkBody(12))
                        .foregroundStyle(WK.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 16).fill(WK.inputBg))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(selected ? WK.signal : WK.inputBorder, lineWidth: selected ? 2 : 1)
            )
            .opacity(mode.isLocked ? 0.78 : 1)
        }
        .buttonStyle(.plain)
    }

    // MARK: - BYO detail

    private var byoDetail: some View {
        VStack(alignment: .leading, spacing: 8) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Voice API key")
                    .font(.wkBody(12, .medium))
                    .foregroundStyle(WK.textSecondary)
                SecureField("ElevenLabs / Cartesia key", text: $voiceKey)
                    .font(.wkBody(15))
                    .foregroundStyle(WK.textPrimary)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .background(RoundedRectangle(cornerRadius: 12).fill(WK.inputBg))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(WK.inputBorder, lineWidth: 1))
                    .onChange(of: voiceKey) { _, newValue in
                        settings.voiceApiKey = newValue.trimmingCharacters(in: .whitespaces)
                    }
            }
            Text("Sent only to your own Mac's voice proxy. It falls back to your Mac's built-in voice on any error.")
                .font(.wkBody(11))
                .foregroundStyle(WK.textTertiary)
        }
        .padding(.top, 2)
    }

    // MARK: - Sample (root-cause audio fix lives here)

    private var playSampleButton: some View {
        Button(action: playSample) {
            HStack(spacing: 8) {
                Image(systemName: "play.circle.fill")
                Text("Play sample")
            }
            .font(.wkBody(15, .semibold))
            .foregroundStyle(WK.bgBottom)
            .padding(.vertical, 12).frame(maxWidth: .infinity)
            .background(RoundedRectangle(cornerRadius: 14).fill(WK.signal))
        }
        .buttonStyle(.plain)
        .padding(.top, 4)
    }

    private func playSample() {
        // Persist the BYO key first so the sample uses it.
        if settings.voiceMode == .byoVoice {
            settings.voiceApiKey = voiceKey.trimmingCharacters(in: .whitespaces)
        }

        // Make the byoVoice / premium fallback legible instead of "it sounds robotic."
        switch settings.voiceMode {
        case .byoVoice where settings.voiceApiKey.isEmpty:
            sampleNote = "This will use your Mac's voice until you add a key."
        case .premium:
            sampleNote = "Preview in the on-device voice while Premium is locked."
        default:
            sampleNote = nil
        }

        // THE FIX: activate a real playback audio session before speaking. Without it the
        // sample played through the receiver at low quality and honored the silent switch,
        // which read as "robotic." A live call already sets a category; this covers the
        // no-call Settings case only.
        SampleAudio.begin()

        let speaker: Speaker
        switch settings.voiceMode {
        case .robot:    speaker = SystemSpeaker()
        case .byoVoice: speaker = BYOVoiceSpeaker(brokerConfig: settings.brokerConfig,
                                                  apiKey: settings.voiceApiKey)
        case .premium:  speaker = SystemSpeaker()   // locked -> on-device preview
        }
        previewSpeaker = speaker
        speaker.onFinish = {
            SampleAudio.end()
            previewSpeaker = nil
        }
        speaker.speak("Hey, it's Mara. This is how I'll sound on your walk.")
    }

    // MARK: - Get a voice key (honest affiliate link)

    private var getKeyLink: some View {
        let provider = VoiceProvider.primary
        return VStack(alignment: .leading, spacing: 4) {
            Button {
                openURL(provider.signupURL)
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.up.right.square")
                    Text("Get a voice key")
                }
                .font(.wkBody(14, .semibold))
                .foregroundStyle(WK.signal)
            }
            .buttonStyle(.plain)

            Text("A natural voice runs through your own Mac with your own key. This opens where to get one.")
                .font(.wkBody(11))
                .foregroundStyle(WK.textTertiary)
                .fixedSize(horizontal: false, vertical: true)

            // Disclosure shows ONLY for a provider with a real referral program.
            if let disclosure = provider.disclosure {
                Text(disclosure)
                    .font(.wkBody(10))
                    .foregroundStyle(WK.textTertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 6)
    }
}
