import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing: ~/.config/lightcurve/keystore.properties (storeFile/storePassword/keyAlias/keyPassword).
val keystoreProps = Properties().apply {
    val file = file(System.getProperty("user.home") + "/.config/lightcurve/keystore.properties")
    if (file.exists()) file.inputStream().use { load(it) }
}

// Each commit is its own build: versionCode is the number of commits, so a newer commit always updates in place.
val commitCount: Int = runCatching {
    val git = ProcessBuilder("git", "rev-list", "--count", "HEAD").directory(rootDir).redirectErrorStream(true).start()
    git.inputStream.bufferedReader().readText().trim().toInt().takeIf { git.waitFor() == 0 }
}.getOrNull() ?: 1

android {
    namespace = "ca.heeney.lightcurve"
    compileSdk = 35

    defaultConfig {
        applicationId = "ca.heeney.lightcurve"
        minSdk = 29
        targetSdk = 35
        versionCode = commitCount
        versionName = "${project.property("lightcurveVersion")}.$commitCount"
    }

    signingConfigs {
        create("release") {
            if (keystoreProps.isNotEmpty()) {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release")
        }
    }

    buildFeatures {
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    lint {
        checkReleaseBuilds = false
    }
    testOptions {
        unitTests.isReturnDefaultValues = true
    }
    sourceSets["main"].kotlin.srcDir("src/main/kotlin")
    sourceSets["test"].kotlin.srcDir("src/test/kotlin")
}

dependencies {
    testImplementation("junit:junit:4.13.2")
}
