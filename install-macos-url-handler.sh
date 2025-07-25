#!/bin/bash
# install-macos-url-handler.sh
# Script to install GlobalProtect callback URL handler on macOS

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Configuration
APP_NAME="GlobalProtectURLHandler"
APP_PATH="/Applications/${APP_NAME}.app"
GPCLIENT_PATH="/usr/local/bin/gpclient"
URL_SCHEME="globalprotectcallback"
TEMP_SCRIPT="/tmp/gpclient-url-handler.applescript"

echo -e "${GREEN}GlobalProtect URL Handler Installer for macOS${NC}"
echo "============================================="

# Check if gpclient exists
if [ ! -f "$GPCLIENT_PATH" ]; then
    echo -e "${YELLOW}Warning: gpclient not found at $GPCLIENT_PATH${NC}"
    echo "Please specify the correct path to gpclient:"
    read -r GPCLIENT_PATH
    if [ ! -f "$GPCLIENT_PATH" ]; then
        echo -e "${RED}Error: gpclient not found at $GPCLIENT_PATH${NC}"
        exit 1
    fi
fi

# Check if we have write permissions to /Applications
if [ ! -w "/Applications" ]; then
    echo -e "${RED}Error: No write permission to /Applications${NC}"
    echo "Please run this script with sudo:"
    echo "  sudo $0"
    exit 1
fi

# Remove existing app if present
if [ -d "$APP_PATH" ]; then
    echo -e "${YELLOW}Removing existing $APP_NAME...${NC}"
    rm -rf "$APP_PATH"
fi

# Create the AppleScript
echo "Creating AppleScript handler..."
cat > "$TEMP_SCRIPT" << EOF
-- GlobalProtect URL Handler
-- This script handles globalprotectcallback:// URLs and passes them to gpclient

on open location urlString
    -- Log the received URL for debugging
    set logFile to "/tmp/gpclient-url-handler.log"
    set currentDate to do shell script "date '+%Y-%m-%d %H:%M:%S'"

    try
        set logFileRef to open for access logFile with write permission
        write (currentDate & " - Received URL: " & urlString & return) to logFileRef starting at eof
        close access logFileRef
    on error
        try
            close access logFile
        end try
    end try

    -- Launch gpclient with the URL
    try
        do shell script "$GPCLIENT_PATH launch-gui " & quoted form of urlString
    on error errMsg
        -- Log any errors
        try
            set logFileRef to open for access logFile with write permission
            write (currentDate & " - Error: " & errMsg & return) to logFileRef starting at eof
            close access logFileRef
        on error
            try
                close access logFile
            end try
        end try

        -- Show error to user
        display dialog "Error launching GlobalProtect client: " & errMsg buttons {"OK"} default button "OK" with icon stop
    end try
end open location

-- Handle if the app is launched without a URL
on run
    display dialog "This application handles globalprotectcallback:// URLs. It should not be launched directly." buttons {"OK"} default button "OK" with icon note
    quit
end run
EOF

# Compile the AppleScript to an application
echo "Compiling AppleScript to application..."
osacompile -o "$APP_PATH" "$TEMP_SCRIPT"

# Check if compilation was successful
if [ ! -d "$APP_PATH" ]; then
    echo -e "${RED}Error: Failed to compile AppleScript application${NC}"
    exit 1
fi

echo "Configuring application properties..."

# Update the Info.plist with URL handler information
PLIST_PATH="$APP_PATH/Contents/Info.plist"

# Add bundle identifier
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string 'com.yuezk.globalprotect-url-handler'" "$PLIST_PATH" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier 'com.yuezk.globalprotect-url-handler'" "$PLIST_PATH"

# Add display name
/usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 'GlobalProtect URL Handler'" "$PLIST_PATH" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName 'GlobalProtect URL Handler'" "$PLIST_PATH"

# Make it a background app (no dock icon)
/usr/libexec/PlistBuddy -c "Add :LSBackgroundOnly bool true" "$PLIST_PATH" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :LSBackgroundOnly true" "$PLIST_PATH"

# Make it a UI element (no menu bar)
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST_PATH" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :LSUIElement true" "$PLIST_PATH"

# Add URL types
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes array" "$PLIST_PATH" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0 dict" "$PLIST_PATH" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLName string 'GlobalProtect Callback Handler'" "$PLIST_PATH" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :CFBundleURLTypes:0:CFBundleURLName 'GlobalProtect Callback Handler'" "$PLIST_PATH"
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes array" "$PLIST_PATH" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string '$URL_SCHEME'" "$PLIST_PATH" 2>/dev/null || \
/usr/libexec/PlistBuddy -c "Set :CFBundleURLTypes:0:CFBundleURLSchemes:0 '$URL_SCHEME'" "$PLIST_PATH"

# Set proper icon (optional - will use default AppleScript icon if not set)
# If you have an icon file, you can add it here:
# cp /path/to/icon.icns "$APP_PATH/Contents/Resources/applet.icns"

# Register the application with Launch Services
echo "Registering URL handler with macOS..."
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -r -f "$APP_PATH"

# Clean up
rm -f "$TEMP_SCRIPT"

# Test the registration
echo -e "\n${GREEN}Testing URL handler registration...${NC}"
HANDLER=$(/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -dump | grep -i "$URL_SCHEME:" | head -1)
if [ -n "$HANDLER" ]; then
    echo -e "${GREEN}✓ URL handler successfully registered!${NC}"
    echo "  Handler: $HANDLER"
else
    echo -e "${YELLOW}⚠ Could not verify registration. You may need to restart or log out/in.${NC}"
fi

# Create uninstall script
UNINSTALL_SCRIPT="/usr/local/bin/uninstall-gp-url-handler"
echo "Creating uninstall script at $UNINSTALL_SCRIPT..."
cat > "$UNINSTALL_SCRIPT" << 'UNINSTALL_EOF'
#!/bin/bash
# Uninstall GlobalProtect URL Handler

echo "Uninstalling GlobalProtect URL Handler..."
rm -rf "/Applications/GlobalProtectURLHandler.app"
echo "URL handler removed. You may need to restart or log out/in for changes to take full effect."
UNINSTALL_EOF
chmod +x "$UNINSTALL_SCRIPT"

echo -e "\n${GREEN}Installation complete!${NC}"
echo -e "\nThe URL handler is now installed at: ${YELLOW}$APP_PATH${NC}"
echo -e "Log file: ${YELLOW}/tmp/gpclient-url-handler.log${NC}"
echo -e "To uninstall, run: ${YELLOW}sudo $UNINSTALL_SCRIPT${NC}"
echo -e "\n${YELLOW}Note:${NC} You may need to log out and back in for the URL handler to be fully recognized."
echo -e "\nTo test the handler, you can run:"
echo -e "  ${GREEN}open 'globalprotectcallback:test'${NC}"
echo -e "\nThis should create a log entry in /tmp/gpclient-url-handler.log"
