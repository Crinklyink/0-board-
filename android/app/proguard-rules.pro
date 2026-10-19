# sherpa-onnx: JNI looks up these Kotlin config classes and their fields by name.
-keep class com.k2fsa.sherpa.onnx.** { *; }
-keepclasseswithmembernames class * { native <methods>; }
# ...and calls the TTS progress callback's specialized invoke(float[]) by name.
-keep class app.oboard.voice.AudioCallback { *; }

# kotlinx.serialization
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class app.oboard.** { *** Companion; }
-keepclasseswithmembers class app.oboard.** { kotlinx.serialization.KSerializer serializer(...); }

# JS bridge methods are invoked reflectively by WebView
-keepclassmembers class app.oboard.ui.WebBridge { @android.webkit.JavascriptInterface <methods>; }

# commons-compress optional codecs we do not use
-dontwarn org.apache.commons.compress.**
-dontwarn org.tukaani.xz.**
-dontwarn com.github.luben.zstd.**
-dontwarn org.brotli.dec.**
-dontwarn org.objectweb.asm.**
-dontwarn javax.naming.**
-dontwarn com.google.errorprone.annotations.**
