import java.net.URI
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// Release signing comes from android/keystore.properties (gitignored; created by scripts/make-keystore.*).
val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "app.oboard"
    // AndroidX 2026 releases require compiling against API 37; behaviour targeting stays at API 36 (Android 16).
    compileSdk = 37

    defaultConfig {
        applicationId = "app.oboard"
        minSdk = 29
        targetSdk = 36
        versionCode = 4
        versionName = "0.4.0"
        ndk { abiFilters += (project.findProperty("abis") as String).split(",").map { it.trim() } }
    }

    signingConfigs {
        if (keystoreProps.getProperty("storeFile") != null) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfigs.findByName("release")?.let { signingConfig = it }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    packaging {
        // Uncompressed, page-aligned native libs (smaller install, required for 16 KB page size devices).
        jniLibs.useLegacyPackaging = false
        resources.excludes += setOf("/META-INF/{AL2.0,LGPL2.1}", "/META-INF/DEPENDENCIES", "/META-INF/LICENSE*", "/META-INF/NOTICE*")
    }

    lint {
        abortOnError = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

// The canvas UI is shared with the TV: bundle ../web into the APK so the phone canvas opens instantly and works offline.
val copyWebAssets = tasks.register<Copy>("copyWebAssets") {
    from(rootProject.file("../web")) { exclude("**/*.md", "**/.DS_Store") }
    into(layout.buildDirectory.dir("generated/webAssets/web"))
}
android.sourceSets.getByName("main").assets.directories.add(layout.buildDirectory.dir("generated/webAssets").get().asFile.path)
tasks.configureEach {
    // Everything that reads the asset folders (merging, lint models) must run after the web copy.
    if (name != "copyWebAssets" && (name.matches(Regex("merge.*Assets")) || name.contains("Lint", ignoreCase = true))) dependsOn(copyWebAssets)
}

// sherpa-onnx (on-device speech recognition and voice) is not published to Maven Central. A fresh checkout fetches the
// official AAR once from its GitHub release; a pinned SHA-256 means a tampered or truncated download is never built in.
val sherpaVersion = "1.13.8"
val sherpaSha256 = "633c24321e06b1fe79feafa03ea16cbc0f8a286641e2da3559bac91bdb13bd96"
val sherpaAar = file("libs/sherpa-onnx-$sherpaVersion.aar")
if (!sherpaAar.exists()) {
    val url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/v$sherpaVersion/sherpa-onnx-$sherpaVersion.aar"
    logger.lifecycle("Fetching $url")
    sherpaAar.parentFile.mkdirs()
    val part = File(sherpaAar.path + ".part")
    val md = MessageDigest.getInstance("SHA-256")
    URI(url).toURL().openStream().use { input ->
        DigestInputStream(input, md).use { d -> part.outputStream().use { out -> d.copyTo(out) } }
    }
    val got = md.digest().joinToString("") { "%02x".format(it) }
    if (got != sherpaSha256) {
        part.delete()
        throw GradleException("sherpa-onnx AAR checksum mismatch (got $got); refusing to build with it")
    }
    check(part.renameTo(sherpaAar)) { "Could not move ${part.name} into place" }
}

dependencies {
    implementation(files(sherpaAar))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.ui.text)
    implementation(libs.androidx.compose.foundation)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.androidx.webkit)
    implementation(libs.okhttp)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.commons.compress)
}
