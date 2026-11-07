package expo.modules.t3nativecontrols

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPrivateKeySpec
import java.security.spec.ECPublicKeySpec

internal object DpopSigner {
  private val parameters = AlgorithmParameters.getInstance("EC").apply {
    init(ECGenParameterSpec("secp256r1"))
  }.getParameterSpec(ECParameterSpec::class.java)

  fun sign(privateD: ByteArray, publicX: ByteArray, publicY: ByteArray, input: String): ByteArray {
    val secret = privateD
    try {
      require(secret.size == 32 && publicX.size == 32 && publicY.size == 32) {
        "Invalid P-256 key coordinate."
      }
      val scalar = BigInteger(1, secret)
      require(scalar.signum() > 0 && scalar < parameters.order) { "Invalid P-256 private key." }
      val factory = KeyFactory.getInstance("EC")
      val privateKey = factory.generatePrivate(ECPrivateKeySpec(scalar, parameters))
      val publicKey = factory.generatePublic(
        ECPublicKeySpec(
          ECPoint(BigInteger(1, publicX), BigInteger(1, publicY)),
          parameters
        )
      )
      val data = input.toByteArray(Charsets.UTF_8)
      val signature = Signature.getInstance("SHA256withECDSA").run {
        initSign(privateKey)
        update(data)
        sign()
      }
      val matches = Signature.getInstance("SHA256withECDSA").run {
        initVerify(publicKey)
        update(data)
        verify(signature)
      }
      require(matches) { "Stored DPoP key does not match its public key." }
      return signature
    } finally {
      secret.fill(0)
    }
  }
}
