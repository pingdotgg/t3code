import CoreGraphics
import CoreImage
import Foundation

/// Renders a string as a QR code CGImage via CoreImage's built-in
/// CIQRCodeGenerator — no third-party dependency, with medium error correction. The output is
/// scaled with a nearest-neighbor affine transform so modules stay crisp;
/// callers must keep `Image.interpolation(.none)` when resizing further.
enum QRCodeRenderer {
    static func image(for text: String, scale: CGFloat = 10) -> CGImage? {
        guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
        filter.setValue(Data(text.utf8), forKey: "inputMessage")
        filter.setValue("M", forKey: "inputCorrectionLevel")
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext().createCGImage(scaled, from: scaled.extent)
    }
}
